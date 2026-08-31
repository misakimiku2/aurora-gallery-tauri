//! S2 验证用的小测试程序：打印文件夹列表与每个文件夹下的图片名。

use ffi_poc::{list_folders, list_images};

fn main() {
    let folders = list_folders();
    println!("共 {} 个文件夹：", folders.len());
    for f in &folders {
        println!("  [{}] {}", f.id, f.name);
    }

    let mut total = 0usize;
    for f in &folders {
        let imgs = list_images(f.id.clone());
        total += imgs.len();
        println!("\n文件夹「{}」下 {} 张图片：", f.name, imgs.len());
        for img in imgs.iter().take(10) {
            let dims = match (img.width, img.height) {
                (Some(w), Some(h)) => format!("{w}x{h}"),
                _ => "?x?".to_string(),
            };
            println!("    {}  ({dims})  {}", img.name, img.path);
        }
        if imgs.len() > 10 {
            println!("    ... 其余 {} 张省略", imgs.len() - 10);
        }
    }
    println!("\n图片总数：{total}");
}
