//! 桌面端「原生覆盖层」—— 视频 P4 / S2.5（2026-10-21）
//!
//! ## 为什么必须有这一层
//! mpv 画面是 `WS_POPUP` 原生窗口（S1 定案），它叠在 WebView 之上，
//! 于是画面区域内 **HTML 一律不可见**（WebView2 airspace）。
//! 凡是要盖在画面上的 UI —— 右键菜单、伸进画面区的竖排音量弹窗 ——
//! 只能画成原生窗口。
//!
//! ## 为什么必须跑专用消息泵线程
//! `mpv_player_*` 命令跑在 Tauri 的 invoke 线程上，**那个线程没有 Win32 消息循环**。
//! 建在那里的窗口收不到鼠标/键盘消息 ⇒ 表现为「看得见、点不动、像穿透了一样」
//! （S1 踩坑 4 的同款坑：画面 popup 当初就因此点不动，最后靠 WH_MOUSE_LL 钩子绕过；
//! 旧竖排音量弹窗正是死在这里 —— 且它的位置还漏了 `ClientToScreen`，
//! 客户区坐标被当成屏幕坐标用，弹窗会飘到别的窗口/别的屏幕上）。
//! 本模块起一条专用线程跑 `GetMessageW` 泵，所有覆盖层窗口归它所有 ⇒ 交互完全正常。
//!
//! ## 样式基准（与前端对齐，不要自创）
//! - 右键菜单 ← `src/components/ContextMenu.tsx`
//! - 竖排音量弹窗 ← `src/components/viewer/VideoControls.tsx`（`<video>` 模式那版）
//! 所有尺寸都是「前端 CSS px × scale」，`scale` = `devicePixelRatio`（前端下发），
//! 换算成物理像素；**不用 GetDpiForWindow**（Win10+ API，会把无 manifest 的
//! test exe 炸成 0xc0000139，见 MEMORY §0）。
//!
//! ## 画法
//! `WS_EX_LAYERED` + `UpdateLayeredWindow`：自己开 DIB 作画、逐像素写 alpha
//! ⇒ 圆角抗锯齿、90% 半透明、柔和投影都能做，且不依赖 GDI+ / Direct2D。

use std::ffi::c_void;
use std::sync::{Arc, Mutex, Once, OnceLock};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use std::thread;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Gdi::{
    ClientToScreen, CreateCompatibleDC, CreateDIBSection, CreateFontIndirectW, CreatePen,
    CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, GetMonitorInfoW,
    GetTextExtentPoint32W, LineTo, MonitorFromPoint, MoveToEx, PtInRect, RoundRect, SelectObject,
    SetBkMode, SetTextColor, AC_SRC_ALPHA, AC_SRC_OVER, ANTIALIASED_QUALITY, BI_RGB, BITMAPINFO,
    BITMAPINFOHEADER, BLENDFUNCTION, DIB_RGB_COLORS, DT_END_ELLIPSIS, DT_NOPREFIX, DT_SINGLELINE,
    DT_VCENTER, HDC, HBITMAP, HGDIOBJ, LOGFONTW, MONITORINFO, MONITOR_DEFAULTTONEAREST, PS_SOLID,
    TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    ReleaseCapture, SetCapture, TrackMouseEvent, TME_LEAVE, TRACKMOUSEEVENT,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    GetWindowRect, KillTimer, LoadCursorW, PostMessageW, RegisterClassW, SetForegroundWindow,
    SetTimer, SetWindowPos, TranslateMessage, UpdateLayeredWindow, IDC_ARROW, MSG, SWP_SHOWWINDOW,
    ULW_ALPHA, WM_APP, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL,
    WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, HWND_MESSAGE,
    HWND_TOPMOST, WINDOW_EX_STYLE, WINDOW_STYLE,
};

/// `WM_MOUSELEAVE` 定义在 Win32_UI_Controls，不为它单独开 feature ⇒ 手写常量
const WM_MOUSELEAVE: u32 = 0x02A3;

// 虚拟键码（同样手写常量）
const VK_ESCAPE: usize = 0x1B;
const VK_RETURN: usize = 0x0D;
const VK_SPACE: usize = 0x20;
const VK_UP: usize = 0x26;
const VK_DOWN: usize = 0x28;

/// 命令投递消息（挂在命令窗口上，由泵线程收取）
const WM_APP_CMD: u32 = WM_APP + 0x77;

const CMD_CLASS: &str = "AuroraOverlayCmd\0";
const MENU_CLASS: &str = "AuroraOverlayMenu\0";
const VOLUME_CLASS: &str = "AuroraOverlayVolume\0";

// ── 颜色（与前端对齐） ────────────────────────────────────────────
// 菜单：bg-[#FAFAFA]/90 dark:bg-[#3a3a3a]/90 · text-gray-800 dark:text-gray-200
//       hover:bg-blue-600 hover:text-white · 分隔 border-black/5 dark:border-white/10
// 音量：bg-white dark:bg-[#3a3a3a] · border-gray-200 dark:border-gray-700
//       轨 bg-gray-300 dark:bg-gray-600 · 填充/拇指 bg-blue-500 · 拇指描边 white / #262626
const MENU_BG_LIGHT: u32 = 0xFAFAFA;
const MENU_BG_DARK: u32 = 0x3A3A3A;
const MENU_FG_LIGHT: u32 = 0x262626; // gray-800
const MENU_FG_DARK: u32 = 0xE5E5E5; // gray-200
const HOVER_BG: u32 = 0x2563EB; // blue-600
const HOVER_FG: u32 = 0xFFFFFF;
const VOL_BG_LIGHT: u32 = 0xFFFFFF;
const VOL_BG_DARK: u32 = 0x3A3A3A;
const VOL_BORDER_LIGHT: u32 = 0xE5E5E5; // gray-200
const VOL_BORDER_DARK: u32 = 0x404040; // gray-700
const TRACK_LIGHT: u32 = 0xD4D4D4; // gray-300
const TRACK_DARK: u32 = 0x525252; // gray-600
const ACCENT: u32 = 0x3B82F6; // blue-500

/// COLORREF = 0x00BBGGRR（Windows 蓝-绿-红序）
#[inline]
fn cr(rgb: u32) -> COLORREF {
    COLORREF(((rgb & 0xFF) << 16) | (rgb & 0xFF00) | ((rgb >> 16) & 0xFF))
}

/// 两色按 t 混合（t=1 → a）
#[inline]
fn mix(a: u32, b: u32, t: f64) -> u32 {
    let ch = |v: u32, sh: i32| ((v >> sh) & 0xFF) as f64;
    let r = ch(a, 16) * t + ch(b, 16) * (1.0 - t);
    let g = ch(a, 8) * t + ch(b, 8) * (1.0 - t);
    let bl = ch(a, 0) * t + ch(b, 0) * (1.0 - t);
    ((r.round() as u32) << 16) | ((g.round() as u32) << 8) | (bl.round() as u32)
}

// ─────────────────────────── 公共 API ───────────────────────────

/// 右键菜单请求。`on_pick` 收到被点中的项下标（与 `mpv_player::MENU_ACTIONS` 对齐）。
pub struct MenuRequest {
    pub labels: Vec<String>,
    /// devicePixelRatio（前端下发）
    pub scale: f64,
    pub dark: bool,
    /// 主窗口 hwnd（关闭后把键盘焦点还回去；0 = 不管）
    pub parent: isize,
    pub on_pick: Arc<dyn Fn(usize) + Send + Sync>,
}

/// 菜单图标位图：前端把 lucide 图标用 canvas 栅格化后的 **RGBA**（白色、透明底）。
/// Rust 按 alpha 混合进菜单 DIB，颜色按 hover 状态着色 ⇒ 一份位图两种状态。
#[derive(Clone)]
pub struct MenuIcon {
    /// 位图边长（物理像素，正方形）
    pub size: i32,
    pub rgba: Vec<u8>,
}

static MENU_ICONS: Mutex<Vec<MenuIcon>> = Mutex::new(Vec::new());

fn lock_icons() -> std::sync::MutexGuard<'static, Vec<MenuIcon>> {
    match MENU_ICONS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// 接收前端栅格化的菜单图标（base64 RGBA；下标同 MENU_ACTIONS）。
/// 解码失败/尺寸异常的项直接丢弃，菜单回退到内置折线图标。
pub fn set_menu_icons(icons_b64: Vec<String>) -> Result<(), String> {
    let mut out = Vec::with_capacity(icons_b64.len());
    for b64 in icons_b64 {
        let Ok(bytes) = B64.decode(b64.as_bytes()) else { continue };
        let n = (bytes.len() as f64 / 4.0).sqrt().round() as i32;
        if n < 4 || n > 128 || (n * n * 4) as usize != bytes.len() {
            continue;
        }
        out.push(MenuIcon { size: n, rgba: bytes });
    }
    *lock_icons() = out;
    Ok(())
}

/// 竖排音量弹窗请求。`anchor_*` = **主窗口客户区物理像素**（Rust 侧负责 ClientToScreen）。
pub struct VolumeRequest {
    pub anchor_x: i32,
    pub anchor_y: i32,
    /// 0-100（mpv 口径）
    pub value: f64,
    pub scale: f64,
    pub dark: bool,
    pub parent: isize,
    pub on_change: Arc<dyn Fn(f64) + Send + Sync>,
}

enum Cmd {
    Menu(MenuRequest),
    Volume(VolumeRequest),
    /// 只关音量弹窗（当前由 mpv stop → `close_all` 统一收；保留供「只关音量」场景）
    #[allow(dead_code)]
    CloseVolume,
    CloseAll,
    /// 全局鼠标按下（由 mpv_player 的 WH_MOUSE_LL 钩子转发；落在弹窗外则关闭）
    MouseDown(i32, i32),
}

static START: Once = Once::new();
static CMD_WINDOW: OnceLock<isize> = OnceLock::new();
static QUEUE: Mutex<Vec<Cmd>> = Mutex::new(Vec::new());
/// 覆盖层窗口的**内容矩形**（不含投影留白），供「点在外面就关」判定。
static RECTS: Mutex<[Option<RECT>; 2]> = Mutex::new([None, None]);

const IDX_MENU: usize = 0;
const IDX_VOLUME: usize = 1;

fn lock_queue() -> std::sync::MutexGuard<'static, Vec<Cmd>> {
    match QUEUE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

fn lock_rects() -> std::sync::MutexGuard<'static, [Option<RECT>; 2]> {
    match RECTS.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// 启动覆盖层线程（幂等）。任何 API 内部都会先调它。
pub fn start() {
    START.call_once(|| {
        let built = thread::Builder::new()
            .name("aurora-native-overlay".into())
            .spawn(overlay_thread);
        match built {
            Ok(_) => {
                // 等命令窗口就绪（超时放弃，避免线程提前 panic 时死等）
                let deadline = Instant::now() + Duration::from_secs(5);
                while CMD_WINDOW.get().is_none() && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(1));
                }
            }
            Err(e) => log::error!("[overlay] 覆盖层线程启动失败: {}", e),
        }
    });
}

fn post(cmd: Cmd) {
    start();
    {
        let mut q = lock_queue();
        q.push(cmd);
    }
    if let Some(h) = CMD_WINDOW.get() {
        unsafe {
            let _ = PostMessageW(Some(HWND(*h as *mut c_void)), WM_APP_CMD, WPARAM(0), LPARAM(0));
        }
    }
}

/// 弹出自绘右键菜单（鼠标位置，自动避开屏幕边缘）。
pub fn show_menu(req: MenuRequest) {
    post(Cmd::Menu(req));
}

/// 显示（或 toggle 关闭）自绘竖排音量弹窗。
pub fn show_volume(req: VolumeRequest) {
    post(Cmd::Volume(req));
}

/// 关闭音量弹窗（切文件 / 关查看器）。幂等。
/// 当前调用路径是 mpv stop → `close_all`（一并收菜单）；单独保留供将来只用。
#[allow(dead_code)]
pub fn hide_volume() {
    if lock_rects()[IDX_VOLUME].is_some() {
        post(Cmd::CloseVolume);
    }
}

/// 关闭所有覆盖层窗口（mpv stop 时）。
pub fn close_all() {
    let any = {
        let r = lock_rects();
        r[IDX_MENU].is_some() || r[IDX_VOLUME].is_some()
    };
    if any {
        post(Cmd::CloseAll);
    }
}

/// **同步**判定：该屏幕点是否落在某个覆盖层窗口内。
///
/// 由 mpv_player 的鼠标钩子在回调里同步调用（必须极快，只做两次 PtInRect）：
/// 命中 ⇒ 这次点击归覆盖层，**不要**再转发成「点击画面 = 暂停」。
pub fn hit_test_exclusive(x: i32, y: i32) -> bool {
    let rects = lock_rects();
    let pt = POINT { x, y };
    rects.iter().flatten().any(|r| unsafe { PtInRect(r, pt) }.as_bool())
}

/// 通知覆盖层：全局发生了一次鼠标按下（用于「点在外面就关」）。异步，不阻塞钩子。
pub fn notify_mouse_down(x: i32, y: i32) {
    if hit_test_exclusive(x, y) {
        return; // 落在自己身上，交给窗口过程处理
    }
    let any = {
        let r = lock_rects();
        r[IDX_MENU].is_some() || r[IDX_VOLUME].is_some()
    };
    if any {
        post(Cmd::MouseDown(x, y));
    }
}

// ─────────────────────────── 泵线程 ───────────────────────────

fn overlay_thread() {
    if let Err(e) = register_classes() {
        log::error!("[overlay] 注册窗口类失败: {}", e);
        return;
    }

    // 命令接收窗口（message-only：不可见、不参与 z-order，只排队消息）
    let cmd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(CMD_CLASS.encode_utf16().collect::<Vec<u16>>().as_ptr()),
            PCWSTR(std::ptr::null()),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
        .ok()
    };
    let cmd = match cmd {
        Some(h) => h,
        None => {
            log::error!("[overlay] 命令窗口创建失败");
            return;
        }
    };
    let _ = CMD_WINDOW.set(cmd.0 as isize);

    let mut msg = MSG::default();
    loop {
        let r = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        if !r.as_bool() {
            break; // WM_QUIT / 错误
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn register_classes() -> Result<(), String> {
    let hmodule = unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandleW: {}", e))?;
    let hinstance = HINSTANCE(hmodule.0);
    for (name, proc) in [
        (CMD_CLASS, cmd_proc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT),
        (MENU_CLASS, menu_proc as _),
        (VOLUME_CLASS, volume_proc as _),
    ] {
        let wide: Vec<u16> = name.encode_utf16().collect();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: hinstance,
            lpszClassName: PCWSTR(wide.as_ptr()),
            hCursor: unsafe { LoadCursorW(None, IDC_ARROW) }.unwrap_or_default(),
            ..Default::default()
        };
        if unsafe { RegisterClassW(&wc) } == 0 {
            let e = std::io::Error::last_os_error();
            // 已注册（重复调用）不算错
            if e.raw_os_error() != Some(1410) {
                return Err(format!("RegisterClassW({}) 失败: {}", name, e));
            }
        }
    }
    Ok(())
}

unsafe extern "system" fn cmd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_APP_CMD {
        let pending: Vec<Cmd> = {
            let mut q = lock_queue();
            std::mem::take(&mut *q)
        };
        for c in pending {
            dispatch(c);
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn dispatch(cmd: Cmd) {
    match cmd {
        Cmd::Menu(req) => open_menu(req),
        Cmd::Volume(req) => open_volume(req),
        Cmd::CloseVolume => close_volume(),
        Cmd::CloseAll => {
            close_menu();
            close_volume();
        }
        Cmd::MouseDown(x, y) => {
            let pt = POINT { x, y };
            let (menu_hit, vol_hit) = {
                let r = lock_rects();
                (inside_only(&r[IDX_MENU], pt), inside_only(&r[IDX_VOLUME], pt))
            };
            if !vol_hit {
                close_volume(); // 没开就是 no-op
            }
            if !menu_hit {
                close_menu();
            }
        }
    }
}

#[inline]
fn inside_only(r: &Option<RECT>, pt: POINT) -> bool {
    match r {
        Some(r) => unsafe { PtInRect(r, pt) }.as_bool(),
        None => false,
    }
}

// ─────────────────────────── 分层窗口 ───────────────────────────

/// 一个 `WS_EX_LAYERED` 窗口的离屏画布：GDI 正常作画 → 逐像素写 alpha → 合成。
///
/// 内含 GDI 句柄（`*mut c_void`，天然非 Send）；窗口**只由泵线程创建/销毁**，
/// 但状态要放进 `static Mutex<…>`（那要求 Send）⇒ 显式声明 Send。
unsafe impl Send for Layer {}

struct Layer {
    hwnd: HWND,
    w: i32,
    h: i32,
    /// 投影留白（内容区在窗口内缩进 pad）
    pad: i32,
    /// 圆角半径（物理像素）
    radius: f64,
    /// 内容区不透明度 0-1（菜单 0.9 = CSS 的 /90；音量弹窗 1.0）
    base_alpha: f64,
    /// 投影最大不透明度 0-1
    shadow: f64,
    hdc: HDC,
    dib: HBITMAP,
    old: HBITMAP,
    /// DIB 像素首地址（存 usize 以免 `*mut u32` 让本结构失去 Send）
    bits: usize,
}

impl Layer {
    fn new(hwnd: HWND, pad: i32, radius: f64, base_alpha: f64, shadow: f64) -> Self {
        Layer {
            hwnd,
            w: 0,
            h: 0,
            pad,
            radius,
            base_alpha,
            shadow,
            hdc: HDC(std::ptr::null_mut()),
            dib: HBITMAP(std::ptr::null_mut()),
            old: HBITMAP(std::ptr::null_mut()),
            bits: 0,
        }
    }

    unsafe fn resize(&mut self, w: i32, h: i32) -> Result<(), String> {
        if self.hdc.is_invalid() {
            self.hdc = CreateCompatibleDC(None);
            if self.hdc.is_invalid() {
                return Err("CreateCompatibleDC 失败".into());
            }
        }
        if w == self.w && h == self.h && !self.dib.is_invalid() {
            return Ok(());
        }
        if !self.dib.is_invalid() {
            let _ = SelectObject(self.hdc, HGDIOBJ(self.old .0));
            let _ = DeleteObject(HGDIOBJ(self.dib.0));
        }
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h; // 负值 = 自上而下（top-down），行序与屏幕一致
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;
        let mut bits: *mut std::ffi::c_void = std::ptr::null_mut();
        let dib = CreateDIBSection(Some(self.hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0)
            .map_err(|e| format!("CreateDIBSection 失败: {}", e))?;
        let old = SelectObject(self.hdc, HGDIOBJ(dib.0));
        self.dib = dib;
        self.old = HBITMAP(old.0);
        self.bits = bits as usize;
        self.w = w;
        self.h = h;
        // 整块清零（透明），避免上一次的残影
        if self.bits != 0 {
            std::ptr::write_bytes(self.bits as *mut u8, 0, (w as usize) * (h as usize) * 4);
        }
        Ok(())
    }

    fn dc(&self) -> HDC {
        self.hdc
    }

    /// 逐像素写 alpha（圆角抗锯齿 + 柔和投影）并合成到窗口。
    unsafe fn commit(&mut self) {
        if self.bits == 0 || self.w <= 0 || self.h <= 0 {
            return;
        }
        let (w, h, pad, radius) = (self.w, self.h, self.pad as f64, self.radius);
        let (x0, y0, x1, y1) = (pad, pad, w as f64 - pad, h as f64 - pad);
        let base = self.base_alpha;
        let shadow = self.shadow;
        let bits = self.bits as *mut u32;
        for y in 0..h {
            for x in 0..w {
                let d = rr_sdf(x as f64 + 0.5, y as f64 + 0.5, x0, y0, x1, y1, radius);
                // 圆角覆盖率：内部 1 → 边缘 0.5 → 外部 0
                let cov = (0.5 - d).clamp(0.0, 1.0);
                // 投影：贴边最强，向外 pad 像素衰减到 0（二次曲线更自然）
                let sh = (1.0 - d / pad.max(1.0)).clamp(0.0, 1.0);
                let a = cov * base + (1.0 - cov) * shadow * sh * sh;
                let px = &mut *bits.add((y * w + x) as usize);
                let b = (*px & 0xFF) as f64;
                let g = ((*px >> 8) & 0xFF) as f64;
                let r = ((*px >> 16) & 0xFF) as f64;
                // 投影区强制黑色；内容区按 alpha 预乘
                let (r, g, b) = if cov > 0.0 { (r, g, b) } else { (0.0, 0.0, 0.0) };
                let pr = (r * a).round() as u32;
                let pg = (g * a).round() as u32;
                let pb = (b * a).round() as u32;
                let a255 = (a * 255.0).round().clamp(0.0, 255.0) as u32;
                *px = (a255 << 24) | (pr << 16) | (pg << 8) | pb;
            }
        }
        let mut size = SIZE { cx: w, cy: h };
        let mut src = POINT { x: 0, y: 0 };
        let mut blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let _ = UpdateLayeredWindow(
            self.hwnd,
            None,
            None,
            Some(&mut size),
            Some(self.hdc),
            Some(&mut src),
            COLORREF(0),
            Some(&mut blend),
            ULW_ALPHA,
        );
    }

    unsafe fn destroy(&mut self) {
        if !self.hdc.is_invalid() {
            if !self.dib.is_invalid() {
                let _ = SelectObject(self.hdc, HGDIOBJ(self.old .0));
                let _ = DeleteObject(HGDIOBJ(self.dib.0));
            }
            let _ = DeleteDC(self.hdc);
        }
        self.hdc = HDC(std::ptr::null_mut());
        self.dib = HBITMAP(std::ptr::null_mut());
        self.bits = 0;
    }
}

impl Layer {
    /// 把 RGBA 位图按 alpha 混进当前画布（直线色空间；此时 DIB 尚未预乘）。
    /// 颜色统一用 `tint` —— 前端栅格化的是白色图标，一份位图适配 hover/常态。
    unsafe fn blend_icon(&mut self, x0: i32, y0: i32, icon: &MenuIcon, tint: u32) {
        if self.bits == 0 || self.w <= 0 || self.h <= 0 {
            return;
        }
        let n = icon.size;
        if icon.rgba.len() != (n * n * 4) as usize {
            return;
        }
        let (w, h) = (self.w, self.h);
        let bits = self.bits as *mut u32;
        let tr = ((tint >> 16) & 0xFF) as f64;
        let tg = ((tint >> 8) & 0xFF) as f64;
        let tb = (tint & 0xFF) as f64;
        for yy in 0..n {
            let py = y0 + yy;
            if py < 0 || py >= h {
                continue;
            }
            for xx in 0..n {
                let px = x0 + xx;
                if px < 0 || px >= w {
                    continue;
                }
                let a = icon.rgba[((yy * n + xx) * 4 + 3) as usize] as f64 / 255.0;
                if a <= 0.002 {
                    continue;
                }
                let p = &mut *bits.add((py * w + px) as usize);
                let b = (*p & 0xFF) as f64;
                let g = ((*p >> 8) & 0xFF) as f64;
                let r = ((*p >> 16) & 0xFF) as f64;
                let nr = (tr * a + r * (1.0 - a)).round() as u32;
                let ng = (tg * a + g * (1.0 - a)).round() as u32;
                let nb = (tb * a + b * (1.0 - a)).round() as u32;
                *p = (*p & 0xFF00_0000) | (nr << 16) | (ng << 8) | nb;
            }
        }
    }
}

/// 圆角矩形的有符号距离（<0 = 内部）。
fn rr_sdf(px: f64, py: f64, x0: f64, y0: f64, x1: f64, y1: f64, r: f64) -> f64 {
    let cx = (x0 + x1) / 2.0;
    let cy = (y0 + y1) / 2.0;
    let qx = (px - cx).abs() - ((x1 - x0) / 2.0 - r);
    let qy = (py - cy).abs() - ((y1 - y0) / 2.0 - r);
    let dx = qx.max(0.0);
    let dy = qy.max(0.0);
    (dx * dx + dy * dy).sqrt() + qx.max(qy).min(0.0) - r
}

// ─────────────────────────── GDI 小工具 ───────────────────────────

unsafe fn fill_round(
    hdc: HDC,
    x0: i32,
    y0: i32,
    x1: i32,
    y1: i32,
    r: f64,
    fill: COLORREF,
    border: Option<(COLORREF, i32)>,
) {
    let brush = CreateSolidBrush(fill);
    let old_brush = SelectObject(hdc, HGDIOBJ(brush.0));
    let (pen_color, pen_w) = border.unwrap_or((fill, 0));
    let pen = CreatePen(PS_SOLID, pen_w, pen_color);
    let old_pen = SelectObject(hdc, HGDIOBJ(pen.0));
    let d = (r * 2.0).round().max(0.0) as i32;
    let _ = RoundRect(hdc, x0, y0, x1, y1, d, d);
    let _ = SelectObject(hdc, old_brush);
    let _ = SelectObject(hdc, old_pen);
    let _ = DeleteObject(HGDIOBJ(brush.0));
    let _ = DeleteObject(HGDIOBJ(pen.0));
}

unsafe fn make_font(px: f64, weight: i32) -> isize {
    let mut lf = LOGFONTW::default();
    lf.lfHeight = -px.round() as i32;
    lf.lfWeight = weight;
    lf.lfQuality = ANTIALIASED_QUALITY;
    let face: Vec<u16> = "Segoe UI".encode_utf16().collect();
    for (i, c) in face.iter().enumerate().take(lf.lfFaceName.len() - 1) {
        lf.lfFaceName[i] = *c;
    }
    let f = CreateFontIndirectW(&lf);
    f.0 as isize
}

unsafe fn text_width(hdc: HDC, s: &str) -> i32 {
    let wide: Vec<u16> = s.encode_utf16().collect();
    let mut sz = SIZE::default();
    if GetTextExtentPoint32W(hdc, &wide, &mut sz).as_bool() {
        sz.cx
    } else {
        0
    }
}

unsafe fn draw_text(hdc: HDC, s: &str, rc: &mut RECT) {
    let mut wide: Vec<u16> = s.encode_utf16().collect();
    let _ = DrawTextW(
        hdc,
        &mut wide,
        rc,
        DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX | DT_END_ELLIPSIS,
    );
}

/// 覆盖层图标（lucide 的线性画法；索引与 `mpv_player::MENU_ACTIONS` 对齐）
unsafe fn draw_icon(hdc: HDC, idx: usize, cx: f64, cy: f64, size: f64, color: COLORREF) {
    let pen = CreatePen(PS_SOLID, std::cmp::max(1, (size * 0.11).round() as i32), color);
    let old = SelectObject(hdc, HGDIOBJ(pen.0));
    let h = size / 2.0;
    let line = |x0: f64, y0: f64, x1: f64, y1: f64| {
        let _ = MoveToEx(hdc, x0.round() as i32, y0.round() as i32, None);
        let _ = LineTo(hdc, x1.round() as i32, y1.round() as i32);
    };
    // 箭头头部：tip 处两条短线
    let head = |tx: f64, ty: f64, dx: f64, dy: f64| {
        let l = size * 0.26;
        line(tx, ty, tx - dx * l - dy * l * 0.62, ty - dy * l + dx * l * 0.62);
        line(tx, ty, tx - dx * l + dy * l * 0.62, ty - dy * l - dx * l * 0.62);
    };
    match idx {
        // 播放/暂停：三角
        0 => {
            line(cx - h * 0.55, cy - h, cx - h * 0.55, cy + h);
            line(cx - h * 0.55, cy + h, cx + h, cy);
            line(cx + h, cy, cx - h * 0.55, cy - h);
        }
        // 后退：双左尖角 «
        1 => {
            line(cx + h * 0.3, cy - h, cx - h * 0.4, cy);
            line(cx - h * 0.4, cy, cx + h * 0.3, cy + h);
            line(cx - h * 0.4, cy - h, cx - h * 1.1, cy);
            line(cx - h * 1.1, cy, cx - h * 0.4, cy + h);
        }
        // 前进：双右尖角 »
        2 => {
            line(cx - h * 0.3, cy - h, cx + h * 0.4, cy);
            line(cx + h * 0.4, cy, cx - h * 0.3, cy + h);
            line(cx + h * 0.4, cy - h, cx + h * 1.1, cy);
            line(cx + h * 1.1, cy, cx + h * 0.4, cy + h);
        }
        // 倍速：时钟（折线近似的圆 + 时针/分针）
        3 => {
            let r = h * 0.92;
            for i in 0..=18 {
                let a = (i as f64 / 18.0) * std::f64::consts::PI * 2.0;
                let x = cx + a.cos() * r;
                let y = cy + a.sin() * r;
                if i == 0 {
                    let _ = MoveToEx(hdc, x.round() as i32, y.round() as i32, None);
                } else {
                    let _ = LineTo(hdc, x.round() as i32, y.round() as i32);
                }
            }
            line(cx, cy, cx, cy - r * 0.55);
            line(cx, cy, cx + r * 0.45, cy);
        }
        // 循环：上下两条反向箭头
        4 => {
            line(cx - h * 0.85, cy - h * 0.45, cx + h * 0.35, cy - h * 0.45);
            head(cx + h * 0.9, cy - h * 0.45, 1.0, 0.0);
            line(cx + h * 0.85, cy + h * 0.45, cx - h * 0.35, cy + h * 0.45);
            head(cx - h * 0.9, cy + h * 0.45, -1.0, 0.0);
        }
        // 系统播放器：方框 + 外指箭头
        5 => {
            line(cx - h * 0.35, cy + h * 0.9, cx - h * 0.35, cy - h * 0.05);
            line(cx - h * 0.35, cy - h * 0.05, cx + h * 0.55, cy - h * 0.05);
            line(cx + h * 0.55, cy - h * 0.05, cx + h * 0.55, cy + h * 0.9);
            line(cx + h * 0.55, cy + h * 0.9, cx - h * 0.35, cy + h * 0.9);
            line(cx - h * 0.15, cy - h * 0.4, cx + h * 0.9, cy - h * 0.95);
            head(cx + h * 0.9, cy - h * 0.95, 0.7071, -0.7071);
        }
        // 资源管理器：文件夹
        _ => {
            line(cx - h, cy - h * 0.55, cx - h * 0.35, cy - h * 0.55);
            line(cx - h * 0.35, cy - h * 0.55, cx - h * 0.2, cy - h * 0.15);
            line(cx - h * 0.2, cy - h * 0.15, cx + h, cy - h * 0.15);
            line(cx + h, cy - h * 0.15, cx + h, cy + h * 0.9);
            line(cx + h, cy + h * 0.9, cx - h, cy + h * 0.9);
            line(cx - h, cy + h * 0.9, cx - h, cy - h * 0.55);
        }
    }
    let _ = SelectObject(hdc, old);
    let _ = DeleteObject(HGDIOBJ(pen.0));
}

/// 屏幕点所在显示器的工作区（不含任务栏）
unsafe fn monitor_work(pt: POINT) -> RECT {
    let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
    let mut mi = MONITORINFO::default();
    mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if GetMonitorInfoW(hmon, &mut mi).as_bool() {
        mi.rcWork
    } else {
        RECT { left: 0, top: 0, right: i32::MAX, bottom: i32::MAX }
    }
}

/// 把窗口摆到 (x, y)（左上角，屏幕物理像素），并保证不越出工作区。
unsafe fn place_window(hwnd: HWND, x: i32, y: i32, w: i32, h: i32) {
    let work = monitor_work(POINT { x, y });
    let x = x.max(work.left).min((work.right - w).max(work.left));
    let y = y.max(work.top).min((work.bottom - h).max(work.top));
    let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_SHOWWINDOW);
}

/// 内容矩形的屏幕坐标（窗口矩形内缩 pad）
unsafe fn content_rect(hwnd: HWND, pad: i32) -> RECT {
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r).is_err() {
        return r;
    }
    RECT { left: r.left + pad, top: r.top + pad, right: r.right - pad, bottom: r.bottom - pad }
}

// ─────────────────────────── 右键菜单 ───────────────────────────

struct MenuItem {
    top: i32,
    height: i32,
    separator: bool,
}

struct MenuWin {
    hwnd_val: isize,
    layer: Layer,
    req: MenuRequest,
    items: Vec<MenuItem>,
    icons: Vec<MenuIcon>,
    hover: Option<usize>,
    font: isize,
}

static MENU_WIN: Mutex<Option<MenuWin>> = Mutex::new(None);

fn lock_menu() -> std::sync::MutexGuard<'static, Option<MenuWin>> {
    match MENU_WIN.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

fn open_menu(req: MenuRequest) {
    close_menu();
    let s = req.scale.max(0.5);
    let dark = req.dark;
    let pad = (12.0 * s).round() as i32; // 投影留白
    let radius = 6.0 * s; // rounded-md
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0),
            PCWSTR(MENU_CLASS.encode_utf16().collect::<Vec<u16>>().as_ptr()),
            PCWSTR(std::ptr::null()),
            WINDOW_STYLE(WS_POPUP.0),
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        )
        .ok()
    };
    let hwnd = match hwnd {
        Some(h) => h,
        None => return,
    };

    let font = unsafe { make_font(14.0 * s, 400) }; // text-sm
    let layer = Layer::new(hwnd, pad, radius, 0.9, if dark { 0.55 } else { 0.18 });
    let icons = lock_icons().clone();
    let mut win = MenuWin {
        hwnd_val: hwnd.0 as isize,
        layer,
        req,
        items: Vec::new(),
        icons,
        hover: None,
        font,
    };

    // 先量文字宽度：需要一个临时 DC（用窗口 DC 会导致闪烁，直接建内存 DC）
    let measure = unsafe { CreateCompatibleDC(None) };
    unsafe {
        let _ = SelectObject(measure, HGDIOBJ(win.font as *mut std::ffi::c_void));
        let item_h = (36.0 * s).round() as i32; // py-2 + text-sm 行高 + py-2
        let sep_h = (1.0 * s).round() as i32 + (8.0 * s).round() as i32; // border-t + my-1
        let icon = (14.0 * s).round() as i32;
        let icon_gap = (8.0 * s).round() as i32; // mr-2
        let text_pad = (16.0 * s).round() as i32; // px-4
        let item_mx = (8.0 * s).round() as i32; // mx-2
        let min_w = (180.0 * s).round() as i32;

        let mut max_text = 0;
        for l in &win.req.labels {
            if l == "-" {
                continue;
            }
            max_text = max_text.max(text_width(measure, l));
        }
        let content_w = min_w.max(item_mx * 2 + text_pad * 2 + icon + icon_gap + max_text);
        let mut y = (8.0 * s).round() as i32; // py-2
        for l in &win.req.labels {
            let (h, sep) = if l == "-" { (sep_h, true) } else { (item_h, false) };
            win.items.push(MenuItem { top: y, height: h, separator: sep });
            y += h;
        }
        let content_h = y + (8.0 * s).round() as i32;

        let w = content_w + pad * 2;
        let h = content_h + pad * 2;
        if win.layer.resize(w, h).is_err() {
            let _ = DestroyWindow(hwnd);
            let _ = DeleteDC(measure);
            return;
        }
        win.layer.w = w;
        win.layer.h = h;
        let _ = DeleteDC(measure);

        // 位置：鼠标处，自动避开屏幕边缘
        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let work = monitor_work(pt);
        let x = if pt.x + w > work.right { (work.right - w).max(work.left) } else { pt.x };
        let y = if pt.y + h > work.bottom { (work.bottom - h).max(work.top) } else { pt.y };
        let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_SHOWWINDOW);
    }

    paint_menu(&mut win);
    unsafe {
        lock_rects()[IDX_MENU] = Some(content_rect(hwnd, pad));
        // 键盘焦点给菜单（↑↓/Enter/Esc 才收得到）；关闭时还给主窗口
        let _ = SetForegroundWindow(hwnd);
    }
    *lock_menu() = Some(win);
}

fn paint_menu(win: &mut MenuWin) {
    let s = win.req.scale.max(0.5);
    let dark = win.req.dark;
    let pad = win.layer.pad;
    let (bg, fg, sep) = if dark {
        (MENU_BG_DARK, MENU_FG_DARK, cr(mix(0xFFFFFF, MENU_BG_DARK, 0.10)))
    } else {
        (MENU_BG_LIGHT, MENU_FG_LIGHT, cr(mix(0x000000, MENU_BG_LIGHT, 0.05)))
    };
    let item_mx = (8.0 * s).round() as i32;
    let text_pad = (16.0 * s).round() as i32;
    let icon = (14.0 * s).round() as i32;
    let icon_gap = (8.0 * s).round() as i32;
    let radius = 4.0 * s; // rounded

    let hdc = win.layer.dc();
    unsafe {
        let _ = SelectObject(hdc, HGDIOBJ(win.font as *mut std::ffi::c_void));
        let _ = SetBkMode(hdc, TRANSPARENT);
        // 面板
        fill_round(hdc, pad, pad, win.layer.w - pad, win.layer.h - pad, win.layer.radius, cr(bg), None);
    }
    let content_w = win.layer.w - pad * 2;
    for (i, item) in win.items.iter().enumerate() {
        let top = pad + item.top;
        let bottom = top + item.height;
        unsafe {
            if item.separator {
                let y = top + item.height / 2;
                fill_round(hdc, item_mx + pad, y, pad + content_w - item_mx, y + (1.0 * s).round().max(1.0) as i32, 0.0, sep, None);
                continue;
            }
            let hovered = win.hover == Some(i);
            if hovered {
                fill_round(hdc, pad + item_mx, top, pad + content_w - item_mx, bottom, radius, cr(HOVER_BG), None);
                let _ = SetTextColor(hdc, cr(HOVER_FG));
            } else {
                let _ = SetTextColor(hdc, cr(fg));
            }
            // 图标：优先前端栅格化的 lucide 位图（与界面完全一致、自带抗锯齿）；
            // 没下发/解码失败时回退到内置折线图标。未 hover 时 opacity-70（向底色混 70%）。
            let icon_color = if hovered { HOVER_FG } else { mix(fg, bg, 0.7) };
            let icon_x0 = pad + item_mx + text_pad;
            let icon_y0 = top + (item.height - icon) / 2;
            match win.icons.get(i) {
                Some(bmp) => {
                    win.layer.blend_icon(icon_x0, icon_y0, bmp, icon_color);
                }
                None => {
                    draw_icon(
                        hdc,
                        i,
                        (icon_x0 + icon / 2) as f64,
                        (top + item.height / 2) as f64,
                        icon as f64,
                        cr(icon_color),
                    );
                },
            }
            // 文案
            let label = win.req.labels.get(i).cloned().unwrap_or_default();
            let mut rc = RECT {
                left: pad + item_mx + text_pad + icon + icon_gap,
                top,
                right: pad + content_w - item_mx - text_pad,
                bottom,
            };
            draw_text(hdc, &label, &mut rc);
        }
    }
    unsafe {
        win.layer.commit();
    }
}

fn close_menu() {
    let win = lock_menu().take();
    if let Some(mut win) = win {
        lock_rects()[IDX_MENU] = None;
        let hwnd = HWND(win.hwnd_val as *mut std::ffi::c_void);
        unsafe {
            let _ = DestroyWindow(hwnd);
            if win.font != 0 {
                let _ = DeleteObject(HGDIOBJ(win.font as *mut std::ffi::c_void));
            }
            win.layer.destroy();
            // 焦点还给主窗口（否则 WebView 收不到键盘）
            if win.req.parent != 0 {
                let _ = SetForegroundWindow(HWND(win.req.parent as *mut std::ffi::c_void));
            }
        }
    }
}

unsafe extern "system" fn menu_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_MOUSEMOVE => {
            let y = (lparam.0 >> 16) as i16 as i32;
            let mut guard = lock_menu();
            if let Some(win) = guard.as_mut() {
                // 窗口坐标（含投影留白）→ 内容坐标
                let cy = y - win.layer.pad;
                let hit = win
                    .items
                    .iter()
                    .enumerate()
                    .find(|(_, it)| !it.separator && cy >= it.top && cy < it.top + it.height)
                    .map(|(i, _)| i);
                if hit != win.hover {
                    win.hover = hit;
                    paint_menu(win);
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONDOWN => LRESULT(0),
        WM_LBUTTONUP => {
            // 先取出「点中了谁」，再放锁 —— 回调里可能再次访问菜单状态
            let pick = {
                let mut guard = lock_menu();
                match guard.as_mut() {
                    Some(win) => win.hover.map(|i| (i, win.req.on_pick.clone())),
                    None => None,
                }
            };
            if let Some((i, cb)) = pick {
                cb(i);
                close_menu();
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            let key = wparam.0;
            let mut guard = lock_menu();
            if let Some(win) = guard.as_mut() {
                match key {
                    k if k == VK_ESCAPE => {
                        drop(guard);
                        close_menu();
                        return LRESULT(0);
                    }
                    k if k == VK_UP || k == VK_DOWN => {
                        let n = win.items.iter().filter(|it| !it.separator).count();
                        if n > 0 {
                            let cur = win.hover.unwrap_or(0);
                            let next = if k == VK_DOWN { (cur + 1) % n } else { (cur + n - 1) % n };
                            if win.hover != Some(next) {
                                win.hover = Some(next);
                                paint_menu(win);
                            }
                        }
                    }
                    k if k == VK_RETURN || k == VK_SPACE => {
                        let pick = match guard.as_mut() {
                            Some(win) => win.hover.map(|i| (i, win.req.on_pick.clone())),
                            None => None,
                        };
                        drop(guard);
                        if let Some((i, cb)) = pick {
                            cb(i);
                            close_menu();
                        }
                        return LRESULT(0);
                    }
                    _ => {}
                }
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ─────────────────────────── 竖排音量弹窗 ───────────────────────────

struct VolumeWin {
    hwnd_val: isize,
    layer: Layer,
    req: VolumeRequest,
    value: f64,
    dragging: bool,
    /// 指针是否进来过（没进来过就不启动「移出后自动关」，否则刚点开就被关掉）
    entered: bool,
    leave_timer: bool,
}

static VOLUME_WIN: Mutex<Option<VolumeWin>> = Mutex::new(None);

fn lock_volume() -> std::sync::MutexGuard<'static, Option<VolumeWin>> {
    match VOLUME_WIN.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

/// 移出后延迟关闭（毫秒）
const LEAVE_CLOSE_MS: u32 = 1500;

fn open_volume(req: VolumeRequest) {
    // toggle：已显示则关闭
    if lock_volume().is_some() {
        close_volume();
        return;
    }
    let s = req.scale.max(0.5);
    let pad = (12.0 * s).round() as i32;
    let radius = 8.0 * s; // rounded-lg
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(WS_EX_TOPMOST.0 | WS_EX_TOOLWINDOW.0 | WS_EX_LAYERED.0),
            PCWSTR(VOLUME_CLASS.encode_utf16().collect::<Vec<u16>>().as_ptr()),
            PCWSTR(std::ptr::null()),
            WINDOW_STYLE(WS_POPUP.0),
            0,
            0,
            0,
            0,
            None,
            None,
            None,
            None,
        )
        .ok()
    };
    let hwnd = match hwnd {
        Some(h) => h,
        None => return,
    };

    let content_w = (36.0 * s).round() as i32; // w-5(20) + px-2×2
    let content_h = (112.0 * s).round() as i32; // h-24(96) + py-2×2
    let mut win = VolumeWin {
        hwnd_val: hwnd.0 as isize,
        layer: Layer::new(hwnd, pad, radius, 1.0, 0.22),
        req,
        value: 0.0,
        dragging: false,
        entered: false,
        leave_timer: false,
    };
    win.value = win.req.value.clamp(0.0, 100.0);

    // ⚠️ 位置修正：前端给的是**主窗口客户区**物理像素，必须 ClientToScreen
    let (mut ax, mut ay) = (win.req.anchor_x, win.req.anchor_y);
    if win.req.parent != 0 {
        let mut pt = POINT { x: ax, y: ay };
        unsafe {
            if ClientToScreen(HWND(win.req.parent as *mut std::ffi::c_void), &mut pt).as_bool() {
                ax = pt.x;
                ay = pt.y;
            }
        }
    }
    let w = content_w + pad * 2;
    let h = content_h + pad * 2;
    let gap = (8.0 * s).round() as i32;
    let x = ax - w / 2;
    let mut y = ay - h - gap;
    unsafe {
        // 上方放不下就翻到按钮下方
        let work = monitor_work(POINT { x: ax, y: ay });
        if y < work.top {
            y = ay + gap + (12.0 * s).round() as i32;
        }
        if win.layer.resize(w, h).is_err() {
            let _ = DestroyWindow(hwnd);
            return;
        }
        place_window(hwnd, x, y, w, h);
        lock_rects()[IDX_VOLUME] = Some(content_rect(hwnd, pad));
    }

    paint_volume(&mut win);
    unsafe {
        let _ = SetForegroundWindow(hwnd);
    }
    *lock_volume() = Some(win);
}

/// 轨道几何（内容坐标）：宽 4px、高 96px、居中
fn track_geom(s: f64) -> (f64, f64, f64, f64) {
    let tw = 4.0 * s;
    let th = 96.0 * s;
    let tx = ((36.0 * s) - tw) / 2.0;
    let ty = 8.0 * s;
    (tx, ty, tw, th)
}

fn paint_volume(win: &mut VolumeWin) {
    let s = win.req.scale.max(0.5);
    let dark = win.req.dark;
    let pad = win.layer.pad;
    let (bg, border, groove) = if dark {
        (VOL_BG_DARK, VOL_BORDER_DARK, TRACK_DARK)
    } else {
        (VOL_BG_LIGHT, VOL_BORDER_LIGHT, TRACK_LIGHT)
    };
    let (tx, ty, tw, th) = track_geom(s);
    let fill_h = th * (win.value / 100.0).clamp(0.0, 1.0);
    let fill_top = ty + th - fill_h;
    let thumb_r = 6.0 * s; // w-3 / 2
    let cx = tx + tw / 2.0;

    let hdc = win.layer.dc();
    unsafe {
        // 面板（1px 描边：border-gray-200 / gray-700）
        fill_round(
            hdc,
            pad,
            pad,
            win.layer.w - pad,
            win.layer.h - pad,
            win.layer.radius,
            cr(bg),
            Some((cr(border), 1)),
        );
        // 滑轨
        let ox = pad as f64;
        let oy = pad as f64;
        fill_round(
            hdc,
            (ox + tx).round() as i32,
            (oy + ty).round() as i32,
            (ox + tx + tw).round() as i32,
            (oy + ty + th).round() as i32,
            tw / 2.0,
            cr(groove),
            None,
        );
        // 已填充段
        if fill_h > 0.5 {
            fill_round(
                hdc,
                (ox + tx).round() as i32,
                (oy + fill_top).round() as i32,
                (ox + tx + tw).round() as i32,
                (oy + ty + th).round() as i32,
                (tw / 2.0).min(fill_h / 2.0),
                cr(ACCENT),
                None,
            );
        }
        // 拇指（圆点 + 1px 描边：white / #262626）
        let thumb_border = if dark { 0x262626 } else { 0xFFFFFF };
        fill_round(
            hdc,
            (ox + cx - thumb_r).round() as i32,
            (oy + fill_top - thumb_r).round() as i32,
            (ox + cx + thumb_r).round() as i32,
            (oy + fill_top + thumb_r).round() as i32,
            thumb_r,
            cr(ACCENT),
            Some((cr(thumb_border), 1)),
        );
        win.layer.commit();
    }
}

fn set_volume(win: &mut VolumeWin, v: f64) {
    let next = v.clamp(0.0, 100.0);
    if (next - win.value).abs() < 0.5 {
        return;
    }
    win.value = next;
    let cb = win.req.on_change.clone();
    cb(next);
    paint_volume(win);
}

/// 内容坐标 y → 音量值
fn volume_from_y(win: &VolumeWin, content_y: i32) -> f64 {
    let s = win.req.scale.max(0.5);
    let (_, ty, _, th) = track_geom(s);
    let ratio = ((ty + th) - content_y as f64) / th;
    (ratio * 100.0).clamp(0.0, 100.0)
}

/// 登记「鼠标离开窗口」通知（一次性；每次进入都要重新登记）。
unsafe fn arm_track_leave(hwnd: HWND) {
    let mut tme = TRACKMOUSEEVENT {
        cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
        dwFlags: TME_LEAVE,
        hwndTrack: hwnd,
        dwHoverTime: 0,
    };
    let _ = TrackMouseEvent(&mut tme);
}

fn close_volume() {
    let win = lock_volume().take();
    if let Some(mut win) = win {
        lock_rects()[IDX_VOLUME] = None;
        let hwnd = HWND(win.hwnd_val as *mut std::ffi::c_void);
        unsafe {
            let _ = KillTimer(Some(hwnd), 1);
            let _ = DestroyWindow(hwnd);
            win.layer.destroy();
            if win.req.parent != 0 {
                let _ = SetForegroundWindow(HWND(win.req.parent as *mut std::ffi::c_void));
            }
        }
    }
}

unsafe extern "system" fn volume_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_LBUTTONDOWN => {
            let y = (lparam.0 >> 16) as i16 as i32;
            let mut guard = lock_volume();
            if let Some(win) = guard.as_mut() {
                win.entered = true;
                if win.leave_timer {
                    let _ = KillTimer(Some(hwnd), 1);
                    win.leave_timer = false;
                }
                let cy = y - win.layer.pad;
                // 轨道热区放宽到整个内容宽度，纵向钳制到轨道范围（好点）
                win.dragging = true;
                let _ = SetCapture(hwnd);
                set_volume(win, volume_from_y(win, cy));
                arm_track_leave(hwnd);
            }
            LRESULT(0)
        }
        WM_MOUSEMOVE => {
            let y = (lparam.0 >> 16) as i16 as i32;
            let mut guard = lock_volume();
            if let Some(win) = guard.as_mut() {
                if win.dragging {
                    set_volume(win, volume_from_y(win, y - win.layer.pad));
                } else {
                    if win.leave_timer {
                        let _ = KillTimer(Some(hwnd), 1);
                        win.leave_timer = false;
                    }
                    win.entered = true;
                    // TrackMouseEvent 是一次性的 ⇒ 每次进入都要重新登记，
                    // 否则「离开→回来→再离开」不会再收到 WM_MOUSELEAVE。
                    arm_track_leave(hwnd);
                }
            }
            LRESULT(0)
        }
        WM_LBUTTONUP => {
            let mut guard = lock_volume();
            if let Some(win) = guard.as_mut() {
                win.dragging = false;
            }
            drop(guard);
            unsafe { let _ = ReleaseCapture(); }
            LRESULT(0)
        }
        WM_MOUSELEAVE => {
            let mut guard = lock_volume();
            if let Some(win) = guard.as_mut() {
                // 拖动中不启动（鼠标可能已经被拖出窗口）
                if !win.dragging && win.entered && !win.leave_timer {
                    let _ = SetTimer(Some(hwnd), 1, LEAVE_CLOSE_MS, None);
                    win.leave_timer = true;
                }
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if wparam.0 == 1 {
                let dragging = lock_volume().as_ref().map(|w| w.dragging).unwrap_or(false);
                if !dragging {
                    close_volume();
                }
            }
            LRESULT(0)
        }
        WM_MOUSEWHEEL => {
            let delta = (wparam.0 >> 16) as i16;
            let mut guard = lock_volume();
            if let Some(win) = guard.as_mut() {
                set_volume(win, win.value + if delta > 0 { 5.0 } else { -5.0 });
            }
            LRESULT(0)
        }
        WM_KEYDOWN => {
            let key = wparam.0;
            let mut guard = lock_volume();
            if let Some(win) = guard.as_mut() {
                match key {
                    k if k == VK_ESCAPE => {
                        drop(guard);
                        close_volume();
                        return LRESULT(0);
                    }
                    k if k == VK_UP => set_volume(win, win.value + 5.0),
                    k if k == VK_DOWN => set_volume(win, win.value - 5.0),
                    _ => {}
                }
            }
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}
