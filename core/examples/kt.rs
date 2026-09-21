use std::io::Write;
fn main() {
    let counts: Vec<(String, i64)> = vec![("#k".to_string(),1), ("zzz".to_string(),1), ("0".to_string(),1), ("9".to_string(),1), ("A".to_string(),1)];
    let g = aurora_core::collate::group_tags(&counts, "zh");
    let keys: Vec<&str> = g.iter().map(|(k, _)| k.as_str()).collect();
    writeln!(std::io::stderr(), "keys={:?}", keys).unwrap();
    for (k, items) in &g { writeln!(std::io::stderr(), "  {} -> {:?}", k, items).unwrap(); }
}
