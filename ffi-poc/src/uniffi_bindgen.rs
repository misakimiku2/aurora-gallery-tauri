//! UniFFI 绑定生成器入口（library 模式）。
//! 用法： cargo run --bin uniffi-bindgen generate --library <lib> --language kotlin --out-dir <dir>
fn main() {
    uniffi::uniffi_bindgen_main()
}
