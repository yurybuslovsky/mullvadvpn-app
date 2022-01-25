/// Unwrap and assert that an enum variant is of the expected type.
#[macro_export]
macro_rules! unwrap_enum {
    ($value: expr, $variant: path) => {{
        if let $variant(inner) = $value {
            inner
        } else {
            panic!("Unexpected enum variant! Expected {}", stringify!($variant));
        }
    }};
}
