//! 桌面端原生播放内核（libmpv）—— P4/S1 正式接入。
//!
//! ## 为什么需要这个模块
//!
//! WebView2 = Chromium，官方容器清单只有 `MP4 / Ogg / WebM / WAV / Matroska / HLS`
//! —— **AVI 与 ASF(WMV) 都不在里面**。更糟的是编码层：Windows **没有内置的
//! MPEG-4 Part 2 MFT**，本机只装了 PotPlayer（自带解码器，但不注册到系统），
//! 所以即使把 AVI 无损 remux 成 MP4，Chromium 仍然解不出画面
//! ⇒ remux 对桌面端是无效功（等 100 秒、占 2 GB，换来的还是黑屏）。
//!
//! 而指挥官明确要求：**点击视频必须在软件内播放**，只有右键
//! 「用系统播放器播放」才允许外挂 ⇒ 外挂降级方案作废。
//!
//! ⇒ 桌面端唯一可行解 = 嵌入原生播放内核 libmpv（自带全量 demuxer/decoder），
//!    **直接播原文件，零转码零缓存**（2026-10-20 PoC-A 实测定案）。
//!
//! ## 窗口架构（PoC-A 实测结论，别走回头路）
//!
//! - `WS_CHILD` 挂成 Tauri 子窗口：**有音频无画面** —— 被 WebView2 渲染表面盖住，
//!   与 z-order 无关（airspace 是合成层特性，`SetWindowPos(HWND_TOP)` 救不了）。
//! - **唯一可行：`WS_POPUP` + owner=主窗口** 的 top-level 窗口。
//!   代价：popup 不随 owner 自动移动/缩放 ⇒ 必须 Hook 主窗口
//!   `WM_WINDOWPOSCHANGED` 手动同步位置（本模块 `sync_surface_position`）。
//! - 位置来源：前端量出「媒体显示区」相对视口的 rect（CSS px），**在前端按
//!   `devicePixelRatio` 换算成物理像素**后传给 Rust（devicePixelRatio 直接反映
//!   WebView 渲染标度，比窗口 DPI 更准 —— 含用户 zoom 场景）；Rust 只做
//!   `ClientToScreen` 客户区→屏幕换算。⚠️ 不用 `GetDpiForWindow`：它是 Win10+ API，
//!   无 manifest 的 test harness exe 静态导入会 `STATUS_ENTRYPOINT_NOT_FOUND`。
//! - popup 在 WebView 之上 ⇒ 它覆盖的区域内 HTML 全部不可见：
//!   rect 必须精确等于媒体区（控制条在媒体区外，不受影响）。
//! - `WS_EX_NOACTIVATE`：点击 popup 不抢焦点，键盘事件留在 WebView。
//! - **跟随机制（不用消息 Hook）**：曾计划 `SetWindowSubclass` 主窗口
//!   `WM_WINDOWPOSCHANGED` —— 但 comctl32 v6 需要 manifest 声明，test harness
//!   exe 没有 → `STATUS_ENTRYPOINT_NOT_FOUND`；`SetWindowLongPtrW` 手动链又有
//!   跨线程窗口操作风险。改用 Tauri 2 原生事件：**移动 = JS `onMoved` → 推送
//!   rect；缩放 = JS `ResizeObserver` → 推送 rect**。零 hook、零线程风险，
//!   跟随经 IPC（毫秒级），拖动场景肉眼无感。
//!
//! ## 为什么运行时 LoadLibrary 而不是链接导入库
//!
//! ① shinchiro 的 dev 包只提供 **MinGW 格式**的 `libmpv.dll.a`，
//!    本机工具链是 `x86_64-pc-windows-msvc`，导入库格式不匹配；
//! ② 运行时动态加载正是 **LGPL 2.1 动态链接**的合规形态 ——
//!    用户可自行替换 `libmpv-2.dll`，程序不与之静态绑定；
//! ③ dll 缺失时可优雅降级返回错误，而不是进程起不来
//!    （与「ffmpeg 启动零耦合」同一约定，MEMORY §2.5）。
//!
//! ## 合规
//!
//! libmpv 为 LGPL 2.1+。动态链接闭源软件允许，但必须：
//! ① 随包提供 libmpv 源码获取方式 ② 不阻止用户替换 dll ③ 在 `licenses/` 登记。

// ── 命令层：签名全平台一致，便于 `generate_handler!` 无条件注册 ──────────

// app_handle() 来自 Manager trait（仅命令层用到）
#[cfg(windows)]
use tauri::Manager;

/// 打开（或切换）mpv 播放的文件。
///
/// `x/y/w/h` = 媒体显示区**相对视口**的 rect，**物理像素**（前端已按
/// `devicePixelRatio` 从 CSS px 换算，见 `mpvPlayer.ts`）。
/// `session` = 前端自增的**会话令牌**：effect 重挂（React StrictMode 双挂载）
/// 或快速切文件时，晚到的 open 若发现已有更新的会话则**自杀让位**，
/// 不覆盖新会话的播放器。
/// `background` = letterbox 区背景色（`#RRGGBB`，前端从媒体区 computed style 取，
/// 与图片查看器主题一致；None = 维持默认黑）。
/// 成功返回即已 `FILE_LOADED`（起播），失败返回错误文本（前端据此显示错误卡）。
#[tauri::command]
pub fn mpv_player_open(
    window: tauri::WebviewWindow,
    path: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    session: u64,
    background: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map(|h| h.0 as isize)
            .map_err(|e| format!("取窗口句柄失败: {}", e))?;
        imp::open(hwnd, &path, imp::ViewportRect { x, y, w, h }, session, background, window.app_handle().clone())
    }
    #[cfg(not(windows))]
    {
        let _ = (&window, &path, x, y, w, h, session, background);
        Err("原生播放内核仅支持 Windows 桌面端".to_string())
    }
}

/// 媒体区 rect / 背景色变化（窗口移动、缩放、布局、主题切换）时由前端推送；
/// Rust 立即同步 popup 位置与背景。
#[tauri::command]
pub fn mpv_player_set_rect(
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    background: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let _ = &window;
        imp::set_rect(imp::ViewportRect { x, y, w, h }, background)
    }
    #[cfg(not(windows))]
    {
        let _ = (&window, x, y, w, h, background);
        Err("原生播放内核仅支持 Windows 桌面端".to_string())
    }
}

/// 播放状态快照（前端 ~250ms 轮询一次，驱动控制条进度/时长/音量）。
#[tauri::command]
pub fn mpv_player_state() -> Result<imp::MpvStateDto, String> {
    imp::state()
}

/// 透传 mpv 命令（`set pause yes|no` / `seek <t> absolute` / `set volume <v>` …）。
#[tauri::command]
pub fn mpv_player_command(args: Vec<String>) -> Result<(), String> {
    imp::command(&args)
}

/// 停止播放并销毁渲染窗口（切文件 / 关查看器时调用）。
///
/// `session` = 调用方自己的会话令牌：**只销毁完全匹配的 surface**。
/// 令牌不匹配 = 已有更新的会话在播（StrictMode 重挂 / 快速切文件），忽略即可 ——
/// 否则晚到的 stop 会误杀新会话（2026-10-20 真机复现：一帧画面后消失 + 尚未挂接 mpv）。
#[tauri::command]
pub fn mpv_player_stop(session: u64) -> Result<(), String> {
    imp::stop(session)
}

/// 下发右键原生菜单文案（按当前语言；下标约定见 imp::MENU_ACTIONS）。
/// 顺序：0 播放/暂停 · 1 后退5s · 2 前进5s · 3 切换倍速 · 4 循环 · 5 系统播放器 · 6 资源管理器。
#[tauri::command]
pub fn mpv_player_set_menu_labels(labels: Vec<String>) -> Result<(), String> {
    imp::set_menu_labels(labels)
}

// ── 实现层：Windows ───────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use std::ffi::{c_char, c_double, c_int, c_void, CString};
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::time::{Duration, Instant};

    use libloading::{Library, Symbol};
    use tauri::{Emitter, Manager};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::{ClientToScreen, PtInRect};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        AppendMenuW, CallNextHookEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
        DestroyMenu, DestroyWindow, GetCursorPos, GetWindowRect, RegisterClassW, SetForegroundWindow,
        SetWindowPos, SetWindowsHookExW, TrackPopupMenu, UnhookWindowsHookEx, HHOOK, HMENU,
        HWND_MESSAGE, MF_STRING, MSLLHOOKSTRUCT, SET_WINDOW_POS_FLAGS, TRACK_POPUP_MENU_FLAGS,
        TPM_NONOTIFY, TPM_RIGHTBUTTON, WINDOW_STYLE, WINDOW_EX_STYLE, WH_MOUSE_LL, WNDCLASSW,
        HWND_TOP, SWP_NOACTIVATE, SWP_SHOWWINDOW, WM_COMMAND, WM_LBUTTONDOWN, WM_MOUSEWHEEL,
        WM_RBUTTONDOWN, WS_EX_NOACTIVATE, WS_POPUP, WS_VISIBLE, WS_CLIPSIBLINGS,
    };
    use windows::core::PCWSTR;

    /// 媒体显示区 rect（相对视口，**物理像素** —— DPI 换算在前端 `devicePixelRatio` 做）。
    #[derive(Debug, Clone, Copy)]
    pub struct ViewportRect {
        pub x: f64,
        pub y: f64,
        pub w: f64,
        pub h: f64,
    }

    /// 播放状态快照（camelCase 直接给前端）。
    #[derive(Debug, Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MpvStateDto {
        pub time_pos: Option<f64>,
        pub duration: Option<f64>,
        pub paused: bool,
        pub volume: f64,
        pub muted: bool,
        /// 播放速率（1.0 = 原速）。
        pub speed: f64,
        /// `core-idle`：无活跃播放（EOF / 出错 / 尚未加载）。
        pub idle: bool,
    }

    #[repr(C)]
    struct MpvEvent {
        event_id: c_int,
        error: c_int,
        reply_userdata: u64,
        data: *mut c_void,
    }

    const MPV_EVENT_FILE_LOADED: c_int = 8;
    const MPV_EVENT_END_FILE: c_int = 7;

    // client.h: mpv_format
    const MPV_FORMAT_STRING: u32 = 1;
    const MPV_FORMAT_FLAG: u32 = 3;
    const MPV_FORMAT_DOUBLE: u32 = 5;

    type MpvCreate = unsafe extern "C" fn() -> *mut c_void;
    type MpvSetOptionString =
        unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int;
    type MpvInitialize = unsafe extern "C" fn(*mut c_void) -> c_int;
    type MpvCommand = unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int;
    type MpvGetProperty =
        unsafe extern "C" fn(*mut c_void, *const c_char, u32, *mut c_void) -> c_int;
    type MpvTerminateDestroy = unsafe extern "C" fn(*mut c_void);
    type MpvWaitEvent = unsafe extern "C" fn(*mut c_void, c_double) -> *mut MpvEvent;
    type MpvErrorString = unsafe extern "C" fn(c_int) -> *const c_char;

    struct MpvLib {
        _lib: Library,
        create: MpvCreate,
        set_option_string: MpvSetOptionString,
        initialize: MpvInitialize,
        command: MpvCommand,
        get_property: MpvGetProperty,
        terminate_destroy: MpvTerminateDestroy,
        wait_event: MpvWaitEvent,
        error_string: MpvErrorString,
    }

    unsafe impl Send for MpvLib {}
    unsafe impl Sync for MpvLib {}

    static MPV_LIB: OnceLock<Result<MpvLib, String>> = OnceLock::new();

    /// 活跃的 mpv 渲染面（同一时刻至多一个 —— 查看器单文件播放）。
    struct Surface {
        child: isize,
        ctx: *mut c_void,
        parent: isize,
        /// 前端会话令牌：stop 只杀完全匹配的会话；open 注册时非最新则自杀让位。
        session: u64,
    }

    unsafe impl Send for Surface {}
    unsafe impl Sync for Surface {}

    static SURFACE: Mutex<Option<Surface>> = Mutex::new(None);
    /// 前端已知的最新的会话令牌（open 调用即更新）。晚到的 open 与之不等则让位。
    static LATEST_SESSION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    /// 最近一次前端推送的媒体区 rect（物理 px）。open / set_rect 写入，同步时读取。
    static VIEWPORT_RECT: Mutex<ViewportRect> = Mutex::new(ViewportRect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    });
    /// letterbox 背景色（`#RRGGBB`）。变化才下发 mpv，避免无谓的属性写。
    static BACKGROUND: Mutex<Option<String>> = Mutex::new(None);
    /// AppHandle：鼠标钩子回调（主线程）向 WebView 发事件用。
    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    /// WH_MOUSE_LL 钩子句柄（isize，0 = 未装）。装/卸都在主线程（有消息循环）。
    static MOUSE_HOOK: Mutex<isize> = Mutex::new(0);
    /// 右键菜单文案（前端按当前语言下发，下标约定见 set_menu_labels）。
    static MENU_LABELS: Mutex<Vec<String>> = Mutex::new(Vec::new());
    /// 右键菜单动作 → 事件值（与前端 `onMpvMenuAction` 对齐）。
    const MENU_ACTIONS: [&str; 7] = [
        "toggle-play",
        "seek-back",
        "seek-fwd",
        "cycle-rate",
        "toggle-loop",
        "open-external",
        "show-in-explorer",
    ];
    /// message-only 窗口句柄（TrackPopupMenu 的 WM_COMMAND 落点；isize，0 = 未建）。
    static MENU_WINDOW: Mutex<isize> = Mutex::new(0);

    /// popup 上原生的鼠标交互 → WebView 事件（`mpv-surface`）。
    #[derive(Debug, Clone, serde::Serialize)]
    struct SurfaceMouse {
        /// "click"（左键按下）| "contextmenu"（右键按下）| "wheel"（滚轮）
        kind: String,
        /// wheel 时的滚动量（正 = 远离用户 = 减小音量方向，与 DOM deltaY 同号）
        delta: i16,
    }

    fn lock_surface() -> MutexGuard<'static, Option<Surface>> {
        match SURFACE.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    fn lock_rect() -> MutexGuard<'static, ViewportRect> {
        match VIEWPORT_RECT.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        }
    }

    fn err_text(lib: &MpvLib, rc: c_int) -> String {
        let p = unsafe { (lib.error_string)(rc) };
        if p.is_null() {
            return format!("错误码 {}", rc);
        }
        unsafe { std::ffi::CStr::from_ptr(p) }
            .to_string_lossy()
            .into_owned()
    }

    fn load_lib() -> Result<MpvLib, String> {
        let local = std::env::var("LOCALAPPDATA").map_err(|_| "缺少 LOCALAPPDATA".to_string())?;
        let dll = Path::new(&local)
            .join("com.aurora.gallery")
            .join("mpv")
            .join("libmpv-2.dll");
        if !dll.is_file() {
            return Err(format!("未找到 {}", dll.display()));
        }
        let lib = unsafe { Library::new(&dll) }
            .map_err(|e| format!("加载 {} 失败: {}", dll.display(), e))?;

        macro_rules! sym {
            ($t:ty, $n:literal) => {{
                let s: Symbol<$t> = unsafe { lib.get($n) }
                    .map_err(|e| format!("缺少符号 {}: {}", String::from_utf8_lossy($n), e))?;
                *s
            }};
        }

        // ⚠️ 必须**先**把符号全取完，最后才 move `lib` 进 MpvLib
        let create = sym!(MpvCreate, b"mpv_create\0");
        let set_option_string = sym!(MpvSetOptionString, b"mpv_set_option_string\0");
        let initialize = sym!(MpvInitialize, b"mpv_initialize\0");
        let command = sym!(MpvCommand, b"mpv_command\0");
        let get_property = sym!(MpvGetProperty, b"mpv_get_property\0");
        let terminate_destroy = sym!(MpvTerminateDestroy, b"mpv_terminate_destroy\0");
        let wait_event = sym!(MpvWaitEvent, b"mpv_wait_event\0");
        let error_string = sym!(MpvErrorString, b"mpv_error_string\0");

        Ok(MpvLib {
            _lib: lib,
            create,
            set_option_string,
            initialize,
            command,
            get_property,
            terminate_destroy,
            wait_event,
            error_string,
        })
    }

    fn mpv() -> Result<&'static MpvLib, String> {
        MPV_LIB
            .get_or_init(load_lib)
            .as_ref()
            .map_err(|e| e.clone())
    }

    // ── 属性读取小工具 ──────────────────────────────────────────────

    fn get_f64(lib: &MpvLib, ctx: *mut c_void, name: &str) -> Option<f64> {
        let k = CString::new(name).ok()?;
        let mut out: c_double = 0.0;
        let rc = unsafe {
            (lib.get_property)(ctx, k.as_ptr(), MPV_FORMAT_DOUBLE, &mut out as *mut c_double as *mut c_void)
        };
        if rc < 0 {
            None
        } else {
            Some(out)
        }
    }

    fn get_flag(lib: &MpvLib, ctx: *mut c_void, name: &str) -> Option<bool> {
        let k = CString::new(name).ok()?;
        let mut out: c_int = 0;
        let rc = unsafe {
            (lib.get_property)(ctx, k.as_ptr(), MPV_FORMAT_FLAG, &mut out as *mut c_int as *mut c_void)
        };
        if rc < 0 {
            None
        } else {
            Some(out != 0)
        }
    }

    // ── 原生渲染窗口 ────────────────────────────────────────────────

    const SURFACE_CLASS: &str = "AuroraMpvSurface\0";

    unsafe extern "system" fn surface_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // 右键原生菜单（TrackPopupMenu）的选择结果以 WM_COMMAND 落到 message-only 窗口；
        // 同一个 WndProc 也服务渲染 popup，收到陌生 WM_COMMAND 的概率为零，统一处理无害。
        if msg == WM_COMMAND {
            let id = (wparam.0 & 0xFFFF) as usize;
            if id >= 101 && id < 101 + MENU_ACTIONS.len() {
                if let Some(app) = APP.get() {
                    let _ = app.emit("mpv-menu-action", MENU_ACTIONS[id - 101]);
                }
            }
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    fn ensure_surface_class() -> Result<(), String> {
        static ONCE: OnceLock<Result<(), String>> = OnceLock::new();
        ONCE.get_or_init(|| {
            let name: Vec<u16> = SURFACE_CLASS.encode_utf16().collect();
            let hmodule = unsafe { GetModuleHandleW(None) }
                .map_err(|e| format!("GetModuleHandleW 失败: {}", e))?;
            let wc = WNDCLASSW {
                lpfnWndProc: Some(surface_proc),
                hInstance: HINSTANCE(hmodule.0),
                lpszClassName: PCWSTR(name.as_ptr()),
                ..Default::default()
            };
            if unsafe { RegisterClassW(&wc) } == 0 {
                return Err("RegisterClassW 失败".to_string());
            }
            Ok(())
        })
        .as_ref()
        .map(|_| ())
        .map_err(|e| e.clone())
    }

    /// 建一个 mpv 渲染 popup 窗口（屏幕坐标由主窗口客户区 + 视口 rect 换算）。
    fn create_surface_window(
        parent: isize,
        screen_x: i32,
        screen_y: i32,
        w: i32,
        h: i32,
    ) -> Result<isize, String> {
        ensure_surface_class()?;
        let name: Vec<u16> = SURFACE_CLASS.encode_utf16().collect();

        // WS_POPUP + owner = top-level（绕开 WebView2 airspace，PoC-A 实测定案）；
        // WS_EX_NOACTIVATE：点击画面不抢焦点，键盘事件留在 WebView。
        let style = WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS;
        let ex_style = WINDOW_EX_STYLE(WS_EX_NOACTIVATE.0);

        let child = unsafe {
            CreateWindowExW(
                ex_style,
                PCWSTR(name.as_ptr()),
                PCWSTR(name.as_ptr()),
                style,
                screen_x,
                screen_y,
                w,
                h,
                Some(HWND(parent as *mut c_void)),
                None,
                None,
                None,
            )
        }
        .map_err(|e| format!("创建渲染窗口失败: {}", e))?;

        Ok(child.0 as isize)
    }

    // ── 位置同步（窗口跟随的核心） ─────────────────────────────────

    /// 视口 rect（物理 px）→ 客户区坐标 → 屏幕坐标 → SetWindowPos。
    fn sync_child_to_rect(parent: isize, child: isize, rect: &ViewportRect) -> Result<(), String> {
        if rect.w <= 0.0 || rect.h <= 0.0 {
            return Ok(()); // 尺寸非法（如最小化瞬间）不动
        }
        let hwnd = HWND(parent as *mut c_void);
        let mut pt = POINT {
            x: rect.x.round() as i32,
            y: rect.y.round() as i32,
        };
        // ⚠️ ClientToScreen 返回 BOOL，不是 Result
        if !unsafe { ClientToScreen(hwnd, &mut pt) }.as_bool() {
            return Err("ClientToScreen 失败".to_string());
        }

        let w = rect.w.round() as i32;
        let h = rect.h.round() as i32;
        unsafe {
            let _ = SetWindowPos(
                HWND(child as *mut c_void),
                Some(HWND_TOP),
                pt.x,
                pt.y,
                w,
                h,
                // ⚠️ SWP_NOACTIVATE 必须带：缺了它每次位置同步都会把 popup 激活成
                // 前台窗口，键盘焦点从 WebView 被抢走 → 全部快捷键失效
                //（2026-10-20 真机复现）。NOACTIVATE popup + 不激活式置顶才是正解。
                SET_WINDOW_POS_FLAGS(SWP_SHOWWINDOW.0 | SWP_NOACTIVATE.0),
            );
        }
        Ok(())
    }

    /// 把当前 popup 同步到缓存的媒体区 rect。无活跃 surface 时静默跳过。
    ///
    /// 触发源全部在前端（Tauri `onMoved` / `ResizeObserver` → `mpv_player_set_rect`），
    /// 本函数只做「读缓存 rect → 换算 → SetWindowPos」，无消息 Hook。
    fn sync_surface_position() {
        let guard = lock_surface();
        let Some(s) = guard.as_ref() else { return };
        let rect = *lock_rect();
        let _ = sync_child_to_rect(s.parent, s.child, &rect);
    }

    // ── 点击/滚轮转发（WH_MOUSE_LL 低级鼠标钩子） ──────────────────
    //
    // popup 建在 invoke 线程且无人泵消息 ⇒ 它的 WndProc 收不到鼠标事件。
    // 专用消息泵线程是一整套跨线程窗口管理（S2 评估过，风险大）；
    // 改用 **低级鼠标钩子**：回调投到装钩线程（主线程，tao 事件循环有泵），
    // 判断点击是否落在 popup rect 内，命中则向 WebView 发 `mpv://surface` 事件。
    // 回调只做几何判断 + emit（微秒级），不拖慢系统鼠标。

    /// 钩子回调：只处理左键按下 / 右键 / 滚轮，其余全部透传。
    unsafe extern "system" fn mouse_hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let kind = match wparam.0 as u32 {
                WM_LBUTTONDOWN => Some("click"),
                WM_RBUTTONDOWN => Some("contextmenu"),
                WM_MOUSEWHEEL => Some("wheel"),
                _ => None,
            };
            if let Some(kind) = kind {
                let hit = (|| -> Option<isize> {
                    let guard = lock_surface();
                    let Some(s) = guard.as_ref() else { return None };
                    let mut r = windows::Win32::Foundation::RECT::default();
                    if unsafe { GetWindowRect(HWND(s.child as *mut c_void), &mut r) }.is_err() {
                        return None;
                    }
                    let pt = POINT { x: info.pt.x, y: info.pt.y };
                    if unsafe { PtInRect(&r, pt) }.as_bool() {
                        Some(s.parent)
                    } else {
                        None
                    }
                })();
                if let Some(parent) = hit {
                    match kind {
                        "contextmenu" => {
                            // 右键 → 原生弹出菜单（TrackPopupMenu 画在系统层，能出现在
                            // 鼠标位置；WebView 菜单会被 popup 盖住画不进画面区）。
                            // 注意：不能在钩子回调里同步弹（模态阻塞钩子），投主线程任务。
                            show_context_menu(parent);
                        }
                        "click" => {
                            if let Some(app) = APP.get() {
                                let _ = app.emit("mpv-surface", SurfaceMouse { kind: "click".into(), delta: 0 });
                            }
                        }
                        "wheel" => {
                            let delta = (info.mouseData >> 16) as i16;
                            if let Some(app) = APP.get() {
                                let _ = app.emit("mpv-surface", SurfaceMouse { kind: "wheel".into(), delta });
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    /// 装鼠标钩子（必须在主线程 —— LL 钩子回调投到装钩线程，主线程才有消息循环）。
    ///
    /// **按 SURFACE 状态收敛，不用 installed 原子开关**：StrictMode 序列
    /// open#1 → stop#1 → open#2 会让「装→卸→不装」把钩子留在卸下状态（真机复现：
    /// 点击/滚轮转发全失效）；改为闭包里检查 SURFACE 当前是否活跃，任意交错顺序
    /// 都收敛到正确终态。
    fn enable_click_forward() {
        let Some(app) = APP.get() else { return };
        let _ = app.run_on_main_thread(|| unsafe {
            let hook_cur = *match MOUSE_HOOK.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if hook_cur != 0 {
                return; // 已装
            }
            let surface_alive = lock_surface().is_some();
            if !surface_alive {
                return; // open 与 stop 竞态，stop 赢了 → 不装
            }
            let hmodule = GetModuleHandleW(None).ok();
            let hinstance = hmodule.map(|h| HINSTANCE(h.0));
            if let Ok(h) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), hinstance, 0) {
                *match MOUSE_HOOK.lock() {
                    Ok(mut g) => g,
                    Err(p) => p.into_inner(),
                } = h.0 as isize;
            }
        });
    }

    /// 卸载鼠标钩子（stop 销毁 surface 时；同样必须主线程、同样按状态收敛）。
    fn disable_click_forward() {
        let Some(app) = APP.get() else { return };
        let _ = app.run_on_main_thread(|| unsafe {
            let hook_cur = *match MOUSE_HOOK.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if hook_cur == 0 {
                return; // 未装
            }
            let surface_alive = lock_surface().is_some();
            if surface_alive {
                return; // stop 后又有新会话接管 → 留给新会话用
            }
            let _ = UnhookWindowsHookEx(HHOOK(hook_cur as *mut c_void));
            *match MOUSE_HOOK.lock() {
                Ok(mut g) => g,
                Err(p) => p.into_inner(),
            } = 0;
        });
    }

    // ── 右键原生菜单（TrackPopupMenu） ─────────────────────────────
    //
    // popup 覆盖区内 HTML 不可见 ⇒ WebView 右键菜单画不进画面区。改用**原生
    // Win32 弹出菜单**：画在系统层（popup 之上）、出现在鼠标位置；选择结果以
    // WM_COMMAND 落到 message-only 窗口 → emit `mpv-menu-action` → 前端执行。
    // 菜单文案由前端在 set_menu_labels 按当前语言下发。

    /// 确保存在接收 WM_COMMAND 的 message-only 窗口（主线程创建、主线程泵）。
    unsafe fn ensure_menu_window() -> isize {
        let cur = *match MENU_WINDOW.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if cur != 0 {
            return cur;
        }
        let name: Vec<u16> = SURFACE_CLASS.encode_utf16().collect();
        let hmodule = GetModuleHandleW(None).ok();
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(name.as_ptr()),
            PCWSTR(name.as_ptr()),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            // HWND_MESSAGE = message-only 窗口：不可见、不参与 z-order，只收消息
            Some(HWND_MESSAGE),
            None,
            None,
            None,
        )
        .ok();
        let v = hwnd.map(|h| h.0 as isize).unwrap_or(0);
        *match MENU_WINDOW.lock() {
            Ok(mut g) => g,
            Err(p) => p.into_inner(),
        } = v;
        v
    }

    /// 在鼠标位置弹出右键菜单（主线程任务；TrackPopupMenu 自带模态泵）。
    fn show_context_menu(parent: isize) {
        let Some(app) = APP.get() else { return };
        let _ = app.run_on_main_thread(move || unsafe {
            let labels = match MENU_LABELS.lock() {
                Ok(g) => g.clone(),
                Err(p) => p.into_inner().clone(),
            };
            let Some(menu) = CreatePopupMenu().ok() else { return };
            // MF_STRING + 命令 id（101 起，映射见 MENU_ACTIONS）
            for (i, label) in labels.iter().take(MENU_ACTIONS.len()).enumerate() {
                let wide: Vec<u16> = label.encode_utf16().chain(std::iter::once(0)).collect();
                let _ = AppendMenuW(menu, MF_STRING, 101 + i, PCWSTR(wide.as_ptr()));
            }
            let mut pt = POINT::default();
            let _ = GetCursorPos(&mut pt);
            ensure_menu_window();
            let menu_hwnd = *match MENU_WINDOW.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if menu_hwnd == 0 {
                let _ = DestroyMenu(menu);
                return;
            }
            let _ = TrackPopupMenu(
                menu,
                // TPM_RIGHTBUTTON：左右键都可选中项；TPM_NONOTIFY：不发通知消息
                TRACK_POPUP_MENU_FLAGS(TPM_RIGHTBUTTON.0 | TPM_NONOTIFY.0),
                pt.x,
                pt.y,
                None,
                HWND(menu_hwnd as *mut c_void),
                None,
            );
            let _ = DestroyMenu(menu);
            let _ = parent; // 预留：将来把菜单挂 owner
        });
    }

    // ── mpv 会话 ────────────────────────────────────────────────────

    /// 新建并初始化一个 mpv 核心（wid 渲染到 child）。
    fn create_core(lib: &MpvLib, child: isize, background: Option<&str>) -> Result<*mut c_void, String> {
        let ctx = unsafe { (lib.create)() };
        if ctx.is_null() {
            return Err("mpv_create 返回空指针".to_string());
        }

        // 初始化前选项：wid 必须在这里给
        let rc = unsafe {
            let k = CString::new("wid").unwrap();
            let v = CString::new(format!("{}", child)).unwrap();
            (lib.set_option_string)(ctx, k.as_ptr(), v.as_ptr())
        };
        if rc < 0 {
            unsafe { (lib.terminate_destroy)(ctx) };
            return Err(format!("设置 wid 失败: {}", err_text(lib, rc)));
        }

        let _ = unsafe { (lib.set_option_string)(ctx, c"terminal".as_ptr(), c"no".as_ptr()) };
        let _ = unsafe { (lib.set_option_string)(ctx, c"osc".as_ptr(), c"no".as_ptr()) };
        let _ = unsafe {
            (lib.set_option_string)(ctx, c"input-default-bindings".as_ptr(), c"no".as_ptr())
        };
        let _ = unsafe { (lib.set_option_string)(ctx, c"input-vo-keyboard".as_ptr(), c"no".as_ptr()) };
        // letterbox 背景 = 媒体区主题色（与图片查看器一致，替代 mpv 默认全黑）
        if let Some(bg) = background {
            if let Ok(cbg) = CString::new(bg) {
                let _ = unsafe {
                    (lib.set_option_string)(ctx, c"background-color".as_ptr(), cbg.as_ptr())
                };
            }
        }

        let rc = unsafe { (lib.initialize)(ctx) };
        if rc < 0 {
            unsafe { (lib.terminate_destroy)(ctx) };
            return Err(format!("mpv_initialize 失败: {}", err_text(lib, rc)));
        }
        Ok(ctx)
    }

    /// 运行时更新 letterbox 背景色（主题切换）。变化才下发；不支持运行时改的 vo 吞错
    /// （下次 open 会以初始化选项生效）。
    fn apply_background(lib: &MpvLib, ctx: *mut c_void, bg: &str) {
        let ok = CString::new(bg).ok();
        let Some(cbg) = ok else { return };
        let args: [*const c_char; 4] = [
            c"set".as_ptr(),
            c"background-color".as_ptr(),
            cbg.as_ptr(),
            std::ptr::null(),
        ];
        let rc = unsafe { (lib.command)(ctx, args.as_ptr()) };
        if rc < 0 {
            log::debug!("[mpv] background-color 运行时更新被拒（{}），下次 open 生效", rc);
        }
    }

    /// loadfile 并泵事件，直到 FILE_LOADED（成功）或 END_FILE（失败）。
    fn load_and_wait(lib: &MpvLib, ctx: *mut c_void, path: &str, timeout: Duration) -> Result<(), String> {
        let cmd = CString::new("loadfile").unwrap();
        let arg = CString::new(path).map_err(|e| format!("路径含 NUL: {}", e))?;
        // `replace` = 换片时干净替换当前播放（复用 ctx 场景必需）
        let mode = CString::new("replace").unwrap();
        let args: [*const c_char; 4] =
            [cmd.as_ptr(), arg.as_ptr(), mode.as_ptr(), std::ptr::null()];
        let rc = unsafe { (lib.command)(ctx, args.as_ptr()) };
        if rc < 0 {
            return Err(format!("loadfile 失败: {}", err_text(lib, rc)));
        }

        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let ev = unsafe { (lib.wait_event)(ctx, 0.1) };
            if ev.is_null() {
                break;
            }
            let id = unsafe { (*ev).event_id };
            if id == MPV_EVENT_FILE_LOADED {
                return Ok(());
            }
            if id == MPV_EVENT_END_FILE {
                let code = unsafe { (*ev).error };
                let reason = if code == 0 {
                    "文件立即结束（空文件或全坏帧？）".to_string()
                } else {
                    err_text(lib, code)
                };
                return Err(format!("加载失败：{}", reason));
            }
        }
        Err(format!("等待 file-loaded 超时（{}ms）", timeout.as_millis()))
    }

    // ── 对外行为 ──────────────────────────────────────────────────

    pub fn open(
        parent: isize,
        path: &str,
        rect: ViewportRect,
        session: u64,
        background: Option<String>,
        app: tauri::AppHandle,
    ) -> Result<(), String> {
        let lib = mpv()?;

        // AppHandle 存全局（鼠标钩子回调发事件用；首次 open 登记一次）
        let _ = APP.set(app);

        // rect 先落缓存：窗口创建、跟随同步都读它
        {
            let mut g = lock_rect();
            *g = rect;
        }
        // 会话令牌：登记「前端最新意图」。注册前若发现已有更新的会话 → 自杀让位
        //（StrictMode 双挂载 / 快速切文件时，晚到的 open 不得覆盖新会话的播放器）。
        LATEST_SESSION.fetch_max(session, std::sync::atomic::Ordering::SeqCst);
        // 背景色缓存（新值记下；create_core 初始化选项 + 运行时 set 双保险）
        {
            let mut g = match BACKGROUND.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if background.is_some() {
                *g = background.clone();
            }
        }

        // ⚠️ 并发语义（为什么总是「新建窗口」而不是复用 ctx 换片）：
        // 快速切文件时 open(A) 的 load_and_wait（最长 5s，泵事件）可能与 cleanup 的
        // stop() 并发 —— 复用路径若不持锁用 ctx 就是 use-after-free；持锁泵事件又会让
        // 同步逻辑阻塞。本地新建的 ctx/child 在注册进 SURFACE 之前 stop() 摸不到它
        // ⇒ 天然安全。代价仅是切文件时 popup 重建的黑闪（~百毫秒），S2 再评估复用优化。

        // 新建路径：屏幕坐标 = 主窗口客户区原点 + 视口 rect（已含前端 DPI 换算）
        let hwnd = HWND(parent as *mut c_void);
        let mut pt = POINT {
            x: rect.x.round() as i32,
            y: rect.y.round() as i32,
        };
        if !unsafe { ClientToScreen(hwnd, &mut pt) }.as_bool() {
            return Err("ClientToScreen 失败".to_string());
        }
        let child = create_surface_window(
            parent,
            pt.x,
            pt.y,
            rect.w.round() as i32,
            rect.h.round() as i32,
        )?;

        let ctx = match create_core(lib, child, background.as_deref()) {
            Ok(c) => c,
            Err(e) => {
                let _ = unsafe { DestroyWindow(HWND(child as *mut c_void)) };
                return Err(e);
            }
        };

        if let Err(e) = load_and_wait(lib, ctx, path, Duration::from_millis(5000)) {
            unsafe { (lib.terminate_destroy)(ctx) };
            let _ = unsafe { DestroyWindow(HWND(child as *mut c_void)) };
            return Err(e);
        }

        // 迟到让位：泵事件的 5s 里若前端已开了更新的会话（StrictMode 重挂 / 快速切文件），
        // 本次 open **自杀**而不是替换 —— 否则会把新会话正在播的画面杀掉
        //（2026-10-20 真机：一帧画面后消失就是这个竞态）。
        if LATEST_SESSION.load(std::sync::atomic::Ordering::SeqCst) != session {
            unsafe { (lib.terminate_destroy)(ctx) };
            let _ = unsafe { DestroyWindow(HWND(child as *mut c_void)) };
            return Ok(()); // 前端已不关心本会话；不报错（错误卡反而误导）
        }

        // 成功：替换 surface（并发 open 串行注册，被替换者在此销毁，最终只留一个）
        let mut guard = lock_surface();
        if let Some(old) = guard.take() {
            if old.ctx != ctx {
                unsafe { (lib.terminate_destroy)(old.ctx) };
                let _ = unsafe { DestroyWindow(HWND(old.child as *mut c_void)) };
            }
        }
        *guard = Some(Surface { child, ctx, parent, session });
        drop(guard);

        sync_surface_position();
        // popup 已就位 → 开启「点击/滚轮落在 popup 上」的转发
        enable_click_forward();
        // 保险：把前台还给主窗口。SetWindowPos 已带 NOACTIVATE（不抢前台），
        // 但若 popup 建立路径上仍有任何激活行为，键盘焦点就会留在 popup 上
        // 导致全部快捷键失效（真机复现）。主窗口回前台 = 键盘回 WebView。
        unsafe {
            let _ = SetForegroundWindow(HWND(parent as *mut c_void));
        }
        Ok(())
    }

    pub fn set_rect(rect: ViewportRect, background: Option<String>) -> Result<(), String> {
        let bg_changed = {
            let mut g = match BACKGROUND.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let changed = match (g.as_deref(), background.as_deref()) {
                (Some(old), Some(new)) => old != new,
                (None, Some(_)) => true,
                _ => false,
            };
            if background.is_some() {
                *g = background.clone();
            }
            changed
        };
        {
            let mut g = lock_rect();
            *g = rect;
        }
        sync_surface_position();
        if bg_changed {
            // 主题切换（亮/暗）不伴随窗口几何变化，必须在这里推给 mpv
            if let Ok(guard) = SURFACE.lock() {
                if let Some(s) = guard.as_ref() {
                    if let Some(bg) = background.as_deref() {
                        apply_background(mpv()?, s.ctx, bg);
                    }
                }
            }
        }
        Ok(())
    }

    pub fn state() -> Result<MpvStateDto, String> {
        let lib = mpv()?;
        let guard = lock_surface();
        let s = guard.as_ref().ok_or("尚未挂接 mpv")?;
        let ctx = s.ctx;

        let time_pos = get_f64(lib, ctx, "time-pos");
        let duration = get_f64(lib, ctx, "duration");
        let volume = get_f64(lib, ctx, "volume").unwrap_or(100.0);
        let speed = get_f64(lib, ctx, "speed").unwrap_or(1.0);
        let paused = get_flag(lib, ctx, "pause").unwrap_or(false);
        let muted = get_flag(lib, ctx, "mute").unwrap_or(false);
        let idle = get_flag(lib, ctx, "core-idle").unwrap_or(false);

        Ok(MpvStateDto {
            time_pos,
            duration,
            paused,
            volume,
            muted,
            speed,
            idle,
        })
    }

    pub fn command(args: &[String]) -> Result<(), String> {
        let lib = mpv()?;
        let guard = lock_surface();
        let ctx = guard.as_ref().map(|s| s.ctx).ok_or("尚未挂接 mpv")?;
        drop(guard);

        let owned: Vec<CString> = args
            .iter()
            .map(|s| CString::new(s.as_str()))
            .collect::<Result<_, _>>()
            .map_err(|e| format!("参数含 NUL: {}", e))?;
        let mut ptrs: Vec<*const c_char> = owned.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());

        let rc = unsafe { (lib.command)(ctx, ptrs.as_ptr()) };
        if rc < 0 {
            return Err(format!("命令 {:?} 失败: {}", args, err_text(lib, rc)));
        }
        Ok(())
    }

    pub fn stop(session: u64) -> Result<(), String> {
        let lib = mpv()?;
        let mut guard = lock_surface();
        // 只销毁完全匹配自己会话的 surface：不匹配 = 已有更新会话在播，
        // 晚到的 stop（StrictMode 卸载 / 切文件 cleanup）必须收手
        let is_mine = guard.as_ref().map(|s| s.session == session).unwrap_or(false);
        if is_mine {
            if let Some(s) = guard.take() {
                unsafe { (lib.terminate_destroy)(s.ctx) };
                let _ = unsafe { DestroyWindow(HWND(s.child as *mut c_void)) };
            }
            drop(guard);
            disable_click_forward();
        }
        Ok(())
    }

    pub fn set_menu_labels(labels: Vec<String>) -> Result<(), String> {
        let mut g = match MENU_LABELS.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        *g = labels;
        Ok(())
    }

    /// PoC 诊断保留：开发期核对渲染窗口 rect 用（正式 UI 不依赖）。
    #[allow(dead_code)]
    fn window_rect(hwnd: isize) -> String {
        let mut r = windows::Win32::Foundation::RECT::default();
        match unsafe { GetWindowRect(HWND(hwnd as *mut c_void), &mut r) } {
            Ok(()) => format!(
                "({},{}) {}x{}",
                r.left,
                r.top,
                r.right - r.left,
                r.bottom - r.top
            ),
            Err(_) => "(取 rect 失败)".to_string(),
        }
    }
}

// ── 实现层：非 Windows（macOS / Linux / 安卓）—— 只给明确错误 ────────────

#[cfg(not(windows))]
mod imp {
    use serde::Serialize;

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct MpvStateDto {
        pub time_pos: Option<f64>,
        pub duration: Option<f64>,
        pub paused: bool,
        pub volume: f64,
        pub muted: bool,
        pub idle: bool,
    }

    fn unsupported() -> String {
        "原生播放内核（libmpv）当前仅支持 Windows 桌面端".to_string()
    }

    pub fn open(
        _window: tauri::WebviewWindow,
        _path: &str,
        _x: f64,
        _y: f64,
        _w: f64,
        _h: f64,
        _session: u64,
        _background: Option<String>,
        _app: tauri::AppHandle,
    ) -> Result<(), String> {
        Err(unsupported())
    }

    pub fn set_rect(_rect: ViewportRect, _background: Option<String>) -> Result<(), String> {
        Err(unsupported())
    }

    pub fn state() -> Result<MpvStateDto, String> {
        Err(unsupported())
    }

    pub fn command(_args: &[String]) -> Result<(), String> {
        Err(unsupported())
    }

    pub fn stop(_session: u64) -> Result<(), String> {
        Err(unsupported())
    }

    pub fn set_menu_labels(_labels: Vec<String>) -> Result<(), String> {
        Err(unsupported())
    }
}
