//! 自然序名字比较：数字段按数值比较（1.jpg < 2.jpg < 10.jpg），大小写不敏感，
//! 数值相等视为并列（img01 == img1）。对齐 React 版 `folderSort.ts` 的
//! `compareNaturalNames`（ICU numeric collation）与 Kotlin 端
//! `ui/components/GridModels.kt` 的 `compareNaturalNames`。
//!
//! scanner 的 sort_children 与安卓 MediaStore 服务端（media_store.rs）的名字排序
//! 必须走这里——内联 `to_lowercase().cmp()` 是字典序，会给出 1、10、11、2…。

use std::cmp::Ordering;

/// 名字自然序比较。非数字段沿用码位比较（与 Kotlin 端历史口径一致，避免引入
/// locale collation 依赖）；数字段无论出现在哪里都按十进制数值比较。
pub fn compare_natural_names(a: &str, b: &str) -> Ordering {
    let la: Vec<char> = a.to_lowercase().chars().collect();
    let lb: Vec<char> = b.to_lowercase().chars().collect();
    let (mut i, mut j) = (0usize, 0usize);
    while i < la.len() && j < lb.len() {
        let (ca, cb) = (la[i], lb[j]);
        if ca.is_ascii_digit() && cb.is_ascii_digit() {
            let mut ea = i;
            while ea < la.len() && la[ea].is_ascii_digit() {
                ea += 1;
            }
            let mut eb = j;
            while eb < lb.len() && lb[eb].is_ascii_digit() {
                eb += 1;
            }
            // 去前导零后先比位数再比码位，即十进制数值比较；去零后相等则整段跳过
            let na: String = la[i..ea].iter().collect();
            let nb: String = lb[j..eb].iter().collect();
            let na = na.trim_start_matches('0');
            let nb = nb.trim_start_matches('0');
            let cmp = na.len().cmp(&nb.len()).then_with(|| na.cmp(nb));
            if cmp != Ordering::Equal {
                return cmp;
            }
            i = ea;
            j = eb;
        } else {
            let cmp = ca.cmp(&cb);
            if cmp != Ordering::Equal {
                return cmp;
            }
            i += 1;
            j += 1;
        }
    }
    // 前缀情形：短者在前（"img" < "img2"）
    (la.len() - i).cmp(&(lb.len() - j))
}

#[cfg(test)]
mod tests {
    use super::compare_natural_names;
    use std::cmp::Ordering;

    fn sorted<'a>(names: &[&'a str]) -> Vec<&'a str> {
        let mut v = names.to_vec();
        v.sort_by(|a, b| compare_natural_names(a, b));
        v
    }

    #[test]
    fn numeric_runs_compare_by_value() {
        assert_eq!(
            sorted(&["10.jpg", "1.jpg", "11.jpg", "2.jpg"]),
            vec!["1.jpg", "2.jpg", "10.jpg", "11.jpg"]
        );
        assert_eq!(compare_natural_names("img2.jpg", "img10.jpg"), Ordering::Less);
    }

    #[test]
    fn leading_zeros_tie() {
        assert_eq!(compare_natural_names("img01.jpg", "img1.jpg"), Ordering::Equal);
    }

    #[test]
    fn multi_digit_segments() {
        assert_eq!(compare_natural_names("img2-2.jpg", "img2-10.jpg"), Ordering::Less);
        assert_eq!(compare_natural_names("img2-10.jpg", "img2-2.jpg"), Ordering::Greater);
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(compare_natural_names("Apple.jpg", "banana.JPG"), Ordering::Less);
        assert_eq!(compare_natural_names("BANANA.jpg", "apple.jpg"), Ordering::Greater);
    }

    #[test]
    fn prefix_shorter_first() {
        assert_eq!(compare_natural_names("img", "img2"), Ordering::Less);
        assert_eq!(compare_natural_names("img2", "img"), Ordering::Greater);
        assert_eq!(compare_natural_names("img", "img"), Ordering::Equal);
    }

    #[test]
    fn digit_vs_letter_falls_back_to_codepoint() {
        assert_eq!(compare_natural_names("img2", "imga"), Ordering::Less);
    }
}
