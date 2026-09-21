//! 标签分组与排序：复刻 React 侧 `getPinyinGroup`（`src/utils/textUtils.ts`）与
//! `App.tsx` 的 `groupedTags` 内排序，使三端共用一份算法。
//!
//! `BOUNDARIES` 与 `textUtils.ts` 的边界字表逐字对应，改动需两端同步。

use icu_collator::options::{CollatorOptions, Strength};
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use icu_locale_core::Locale;

pub type Col = CollatorBorrowed<'static>;

fn collator_for(locale_str: &str, strength: Option<Strength>) -> Col {
    let fallback: Locale = "und".parse().expect("static locale");
    let locale: Locale = locale_str.parse().unwrap_or(fallback);
    let prefs = CollatorPreferences::from_locale_strict(&locale).unwrap_or_else(|p| p);
    let mut options = CollatorOptions::default();
    options.strength = strength;
    Collator::try_new(prefs, options).expect("ICU collator data missing")
}

/// `Intl.Collator('zh-Hans-CN', { sensitivity: 'accent' })` 等价物，用于求组键。
pub fn group_collator() -> Col {
    collator_for("zh-Hans-CN", Some(Strength::Secondary))
}

/// `String.prototype.localeCompare(_, locale)` 等价物，用于组内排序。
pub fn order_collator(locale: &str) -> Col {
    collator_for(locale, None)
}

const BOUNDARIES: &[(&str, &str)] = &[
    ("阿", "A"), ("芭", "B"), ("擦", "C"), ("搭", "D"), ("蛾", "E"), ("发", "F"), ("噶", "G"),
    ("哈", "H"), ("击", "J"), ("喀", "K"), ("垃", "L"), ("妈", "M"), ("拿", "N"), ("哦", "O"),
    ("啪", "P"), ("期", "Q"), ("然", "R"), ("撒", "S"), ("塌", "T"), ("挖", "W"), ("昔", "X"),
    ("压", "Y"), ("匝", "Z"),
];

pub fn group_key(collator: &Col, tag: &str) -> String {
    let first = match tag.chars().next() {
        Some(c) => c,
        None => return "#".into(),
    };
    if first.is_ascii_alphabetic() {
        return first.to_ascii_uppercase().to_string();
    }
    if first.is_ascii_digit() {
        return first.to_string();
    }
    if !('\u{4e00}'..='\u{9fa5}').contains(&first) {
        return "#".into();
    }
    let s = first.to_string();
    for (b, g) in BOUNDARIES.iter().rev() {
        if collator.compare(s.as_str(), *b).is_ge() {
            return (*g).to_string();
        }
    }
    "#".into()
}

pub fn sort_tags(tags: &[String], locale: &str) -> Vec<String> {
    let collator = order_collator(locale);
    let mut out = tags.to_vec();
    out.sort_by(|a, b| collator.compare(a.as_str(), b.as_str()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(tag: &str) -> String {
        group_key(&group_collator(), tag)
    }

    #[test]
    fn ascii_and_digits_take_their_own_group() {
        assert_eq!(g("alpha"), "A");
        assert_eq!(g("Beta"), "B");
        assert_eq!(g("1st"), "1");
        assert_eq!(g("9"), "9");
    }

    /// 只有 CJK 统一表意文字基本区（`\u4e00-\u9fa5`）参与拼音分组；假名、谚文、带音符号的
    /// 拉丁字母一律落 `#`。（日文汉字如「写」在基本区内，会照常拼音分组。）
    #[test]
    fn non_han_leading_char_falls_to_hash() {
        for t in ["_under", "-dash", "#hash", ".dot", "@at", " zzz", "한국어", "かな", "Éclair"] {
            assert_eq!(g(t), "#", "{t} should not be pinyin-grouped");
        }
        assert_eq!(g("写真"), "X");
    }

    /// 多音字以 ICU zh 韵母表为准，不是字典读音；两端必须取同一个值。
    #[test]
    fn polyphones_follow_icu_not_the_dictionary() {
        assert_eq!(g("重庆"), "Z");
        assert_eq!(g("长沙"), "Z");
        assert_eq!(g("朝"), "C");
        assert_eq!(g("单"), "D");
        assert_eq!(g("行"), "X");
        assert_eq!(g("乐"), "L");
    }

    #[test]
    fn boundary_chars_close_their_own_group() {
        assert_eq!(g("阿"), "A");
        assert_eq!(g("匝"), "Z");
        assert_eq!(g("萍"), "P");
    }

    #[test]
    fn sort_is_locale_sensitive() {
        let tags: Vec<String> = ["banana", "Apple", "cherry"]
            .iter().map(|s| s.to_string()).collect();
        let zh = sort_tags(&tags, "zh");
        let en = sort_tags(&tags, "en");
        assert_eq!(zh, en);
        assert_eq!(zh, ["Apple", "banana", "cherry"]);
    }
}
