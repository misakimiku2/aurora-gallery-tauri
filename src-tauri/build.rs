fn main() {
    // Force rebuild when lan-share static files change
    println!("cargo:rerun-if-changed=static/lan-share/index.html");
    println!("cargo:rerun-if-changed=static/lan-share/style.css");
    println!("cargo:rerun-if-changed=static/lan-share/app.js");
    
    tauri_build::build()
}
