//! PoC-A：把 libmpv 嵌进 Tauri 原生窗口，绕开 WebView2 的容器 / 解码器限制。
//!
//! ## 为什么需要这个模块
//!
//! WebView2 = Chromium，官方容器清单只有 `MP4 / Ogg / WebM / WAV / Matroska / HLS`
//! —— **AVI 与 ASF(WMV) 都不在里面**。更糟的是编码层：Windows **没有内置的
//! MPEG-4 Part 2 MFT**，本机只装了 PotPlayer（自带解码器，但不注册到系统），
//! 所以即使把 AVI 无损 remux 成 MP4，Chromium 仍然解不出画面。
//!
//! 而指挥官明确要求：**点击视频必须在软件内播放**，只有右键
//! 「用系统播放器播放」才允许外挂 ⇒ 外挂降级方案作废。
//!
//! ⇒ 桌面端唯一可行解 = 嵌入原生播放内核 libmpv（自带全量 demuxer/decoder）。
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

#[tauri::command]
pub fn poc_mpv_status() -> Result<String, String> {
    imp::status()
}

/// `mode`: `"popup"` = top-level 弹出窗口（owner=主窗口）；其余 = `WS_CHILD` 子窗口。
#[tauri::command]
pub fn poc_mpv_open(
    window: tauri::WebviewWindow,
    path: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    mode: Option<String>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map(|h| h.0 as isize)
            .map_err(|e| format!("取窗口句柄失败: {}", e))?;
        imp::open(hwnd, &path, x, y, w, h, mode.as_deref())
    }
    #[cfg(not(windows))]
    {
        let _ = (&window, &path, x, y, w, h, mode);
        Err("原生播放内核仅支持 Windows 桌面端".to_string())
    }
}

#[tauri::command]
pub fn poc_mpv_command(args: Vec<String>) -> Result<(), String> {
    imp::command(&args)
}

#[tauri::command]
pub fn poc_mpv_stop() -> Result<String, String> {
    imp::stop()?;
    Ok("已停止".to_string())
}

// ── 实现层：Windows ───────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use std::ffi::{c_char, c_double, c_int, c_void, CString};
    use std::path::Path;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::time::{Duration, Instant};

    use libloading::{Library, Symbol};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowRect, RegisterClassW,
        SetWindowPos, SET_WINDOW_POS_FLAGS, WINDOW_EX_STYLE, WNDCLASSW, HWND_TOP, SWP_NOMOVE,
        SWP_NOSIZE, SWP_SHOWWINDOW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_POPUP,
        WS_VISIBLE,
    };
    use windows::core::PCWSTR;

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
    const _MPV_FORMAT_FLAG: u32 = 3;
    const _MPV_FORMAT_INT64: u32 = 4;
    const _MPV_FORMAT_DOUBLE: u32 = 5;

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

    struct Surface {
        child: isize,
        ctx: *mut c_void,
    }

    unsafe impl Send for Surface {}
    unsafe impl Sync for Surface {}

    static SURFACE: Mutex<Option<Surface>> = Mutex::new(None);

    fn lock_surface() -> MutexGuard<'static, Option<Surface>> {
        match SURFACE.lock() {
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

    // ── 原生渲染窗口 ────────────────────────────────────────────────

    const SURFACE_CLASS: &str = "AuroraMpvSurface\0";

    unsafe extern "system" fn surface_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
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

    /// 建一个 mpv 渲染窗口，返回句柄（isize）。
    ///
    /// `as_popup` 是本次 PoC 的核心变量：
    /// - `false` → `WS_CHILD`，挂成 Tauri 窗口子窗口（**首次实测：有声音无画面**）
    /// - `true`  → `WS_POPUP` + owner，top-level，绕开 WebView2 airspace 覆盖（待验证）
    fn create_surface_window(
        parent: isize,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        as_popup: bool,
    ) -> Result<isize, String> {
        ensure_surface_class()?;
        let name: Vec<u16> = SURFACE_CLASS.encode_utf16().collect();

        // popup 用**屏幕坐标**；child 用**父窗口客户区坐标**
        let (px, py) = if as_popup {
            let mut pt = POINT { x, y };
            // ⚠️ ClientToScreen 返回 BOOL，不是 Result
            let ok = unsafe { ClientToScreen(HWND(parent as *mut c_void), &mut pt) };
            if !ok.as_bool() {
                return Err("ClientToScreen 失败".to_string());
            }
            (pt.x, pt.y)
        } else {
            (x, y)
        };

        let style = if as_popup {
            WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS
        } else {
            WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN
        };

        let child = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                PCWSTR(name.as_ptr()),
                PCWSTR(name.as_ptr()),
                style,
                px,
                py,
                w,
                h,
                Some(HWND(parent as *mut c_void)),
                None,
                None,
                None,
            )
        }
        .map_err(|e| format!("创建渲染窗口失败: {}", e))?;

        // ⚠️ 提到兄弟窗口顶部 —— WebView2 的渲染表面会覆盖同级子窗口（airspace 问题）
        unsafe {
            let _ = SetWindowPos(
                HWND(child.0),
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SET_WINDOW_POS_FLAGS(SWP_NOMOVE.0 | SWP_NOSIZE.0 | SWP_SHOWWINDOW.0),
            );
        }

        Ok(child.0 as isize)
    }

    // ── 对外行为 ──────────────────────────────────────────────────

    pub fn status() -> Result<String, String> {
        let lib = mpv()?;
        let ctx = unsafe { (lib.create)() };
        if ctx.is_null() {
            return Err("mpv_create 返回空指针".to_string());
        }
        // ⚠️ 必须先 initialize 才能取属性 —— 否则报 "core not initialized"
        let rc = unsafe { (lib.initialize)(ctx) };
        if rc < 0 {
            unsafe { (lib.terminate_destroy)(ctx) };
            return Err(format!("mpv_initialize 失败: {}", err_text(lib, rc)));
        }
        let k = CString::new("mpv-version").unwrap();
        let mut out: *mut c_char = std::ptr::null_mut();
        let rc = unsafe {
            (lib.get_property)(
                ctx,
                k.as_ptr(),
                MPV_FORMAT_STRING,
                &mut out as *mut *mut c_char as *mut c_void,
            )
        };
        if rc < 0 {
            unsafe { (lib.terminate_destroy)(ctx) };
            return Err(format!("取 mpv 版本失败: {}", err_text(lib, rc)));
        }
        let version = unsafe { std::ffi::CStr::from_ptr(out) }
            .to_string_lossy()
            .into_owned();
        unsafe { (lib.terminate_destroy)(ctx) };
        Ok(format!("ok {}", version))
    }

    pub fn open(
        hwnd: isize,
        path: &str,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        mode: Option<&str>,
    ) -> Result<String, String> {
        let as_popup = matches!(mode, Some("popup"));
        let lib = mpv()?;
        let child = create_surface_window(hwnd, x, y, w, h, as_popup)?;

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
        let _ = unsafe { (lib.set_option_string)(ctx, c"input-default-bindings".as_ptr(), c"no".as_ptr()) };

        let rc = unsafe { (lib.initialize)(ctx) };
        if rc < 0 {
            unsafe { (lib.terminate_destroy)(ctx) };
            return Err(format!("mpv_initialize 失败: {}", err_text(lib, rc)));
        }

        let cmd = CString::new("loadfile").unwrap();
        let arg = CString::new(path).map_err(|e| format!("路径含 NUL: {}", e))?;
        let args: [*const c_char; 3] = [cmd.as_ptr(), arg.as_ptr(), std::ptr::null()];
        let rc = unsafe { (lib.command)(ctx, args.as_ptr()) };
        if rc < 0 {
            unsafe { (lib.terminate_destroy)(ctx) };
            return Err(format!("loadfile 失败: {}", err_text(lib, rc)));
        }

        let deadline = Instant::now() + Duration::from_millis(5000);
        let mut loaded = false;
        let mut end_err: Option<String> = None;
        while Instant::now() < deadline {
            let ev = unsafe { (lib.wait_event)(ctx, 0.1) };
            if ev.is_null() {
                break;
            }
            let id = unsafe { (*ev).event_id };
            if id == MPV_EVENT_FILE_LOADED {
                loaded = true;
                break;
            }
            if id == MPV_EVENT_END_FILE {
                end_err = Some(format!("END_FILE error={}", unsafe { (*ev).error }));
                break;
            }
        }

        if !loaded {
            unsafe { (lib.terminate_destroy)(ctx) };
            let _ = unsafe { DestroyWindow(HWND(child as *mut c_void)) };
            return Err(match end_err {
                Some(r) => format!("加载失败：{}", r),
                None => "等待 file-loaded 超时（5s）".to_string(),
            });
        }

        let mut guard = lock_surface();
        if let Some(old) = guard.take() {
            unsafe { (lib.terminate_destroy)(old.ctx) };
            let _ = unsafe { DestroyWindow(HWND(old.child as *mut c_void)) };
        }
        *guard = Some(Surface { child, ctx });
        drop(guard);

        let rect = window_rect(child);
        Ok(format!(
            "已挂接并起播：mode={} parent=0x{:X} child=0x{:X} rect={}",
            if as_popup { "popup" } else { "child" },
            hwnd,
            child,
            rect
        ))
    }

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

    pub fn stop() -> Result<(), String> {
        let lib = mpv()?;
        let mut guard = lock_surface();
        if let Some(s) = guard.take() {
            unsafe { (lib.terminate_destroy)(s.ctx) };
            let _ = unsafe { DestroyWindow(HWND(s.child as *mut c_void)) };
        }
        Ok(())
    }
}

// ── 实现层：非 Windows（macOS / Linux / 安卓）—— 只给明确错误 ────────────

#[cfg(not(windows))]
mod imp {
    fn unsupported() -> String {
        "原生播放内核（libmpv）当前仅支持 Windows 桌面端".to_string()
    }

    pub fn status() -> Result<String, String> {
        Err(unsupported())
    }

    pub fn open(
        _window: tauri::WebviewWindow,
        _path: &str,
        _x: i32,
        _y: i32,
        _w: i32,
        _h: i32,
        _mode: Option<&str>,
    ) -> Result<String, String> {
        Err(unsupported())
    }

    pub fn command(_args: &[String]) -> Result<(), String> {
        Err(unsupported())
    }

    pub fn stop() -> Result<(), String> {
        Err(unsupported())
    }
}
