use std::fmt;

const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
pub struct Output(String);

impl Output {
    pub fn finish(self) -> String {
        self.0
    }
}

impl fmt::Write for Output {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        if self.0.len().saturating_add(value.len()) > MAX_OUTPUT_BYTES {
            return Err(fmt::Error);
        }
        self.0.push_str(value);
        Ok(())
    }
}
