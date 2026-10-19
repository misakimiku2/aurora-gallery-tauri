fn main() {
    // Force rebuild when lan-share static files change
    println!("cargo:rerun-if-changed=static/lan-share/index.html");
    println!("cargo:rerun-if-changed=static/lan-share/style.css");
    println!("cargo:rerun-if-changed=static/lan-share/app.js");

    // 只有 `AURORA_TEST_MANIFEST=1 cargo test` 才需要的补丁。
    //
    // tauri-build 把 Common-Controls v6 的清单只嵌进 **bin 目标**，`cargo test --lib`
    // 那个测试 exe 一份都没有 → comctl32 绑到 System32 的 v5，而链进来的代码要的是
    // v6 才导出的 `TaskDialogIndirect` → 进程在 main() 之前就 0xc0000139
    // STATUS_ENTRYPOINT_NOT_FOUND，一个用例都不跑（2026-10-20 用 PE 导入表比出来的：
    // 应用 exe 有 v6 清单、测试 exe 没有，两者都导入 TaskDialogIndirect）。
    //
    // 为什么用环境变量而不用 `cargo:rustc-link-arg-tests`：Cargo 认定本包「没有 test
    // 目标」（lib 自己的 harness 算 Lib 不算 Test），那条指令会直接报错；而不带后缀的
    // `rustc-link-arg` 会打到所有目标，包括平时那个 bin —— 所以默认不开，只在跑测试时开。
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-env-changed=AURORA_TEST_MANIFEST");
        if std::env::var("AURORA_TEST_MANIFEST").is_ok() {
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!(
                "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
            );
        }
    }

    tauri_build::build()
}
