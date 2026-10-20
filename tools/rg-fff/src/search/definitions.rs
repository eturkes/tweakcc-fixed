use std::sync::LazyLock;

use regex::Regex;

static DECLARATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"^\s*(?:(?:pub(?:\([^)]*\))?|export|default|async|abstract|unsafe|static|protected|private|public|declare)\s+)*",
        r"(?:function(?:\s*\*\s*|\s+)|(?:fn|func|def|struct|enum|trait|class|interface|type|module|object|const|let|var)\s+)",
        r"([$A-Za-z_][$A-Za-z0-9_]*)"
    ))
    .unwrap()
});

pub fn is_symbol(pattern: &str) -> bool {
    let mut bytes = pattern.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphabetic() || matches!(b, b'_' | b'$'))
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'$'))
}

pub fn line_defines(line: &str, pattern: &str, ignore_case: bool) -> bool {
    let Some(captures) = DECLARATION.captures(line) else {
        return false;
    };
    let name = captures.get(1).unwrap();
    if !(name.as_str() == pattern || (ignore_case && name.as_str().eq_ignore_ascii_case(pattern))) {
        return false;
    }
    let after = line[name.end()..].trim_start();
    after.is_empty()
        || after.starts_with(|c: char| matches!(c, '=' | '(' | '{' | ':' | '<' | ';'))
        || ["extends", "implements"].iter().any(|keyword| {
            after
                .strip_prefix(keyword)
                .is_some_and(|rest| rest.starts_with(char::is_whitespace))
        })
}
