use serde::Deserialize;
use crate::{CoreError, Result};

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum Verdict { PassSuggested, RelearnSuggested }

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct Scores { pub accuracy: u8, pub completeness: u8, pub clarity: u8 }

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct Anchor { pub chapter_href: String, pub hint: String }

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct WeakPointItem {
    pub title: String,
    pub detail: String,
    #[serde(default)] pub fixed_in_session: bool,
    #[serde(default)] pub anchor: Option<Anchor>,
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct EvalResult {
    pub verdict: Verdict,
    pub scores: Scores,
    pub summary: String,
    #[serde(default)] pub weak_points: Vec<WeakPointItem>,
    pub final_restatement: String,
    #[serde(default)] pub observation_note: String,
}

/// 从可能带 markdown 围栏/前后缀文本中提取首个 `{`..末个 `}` 并严格解析。
pub fn parse_eval(raw: &str) -> Result<EvalResult> {
    let e: EvalResult = strict_extract(raw)?;
    for s in [e.scores.accuracy, e.scores.completeness, e.scores.clarity] {
        if !(1..=5).contains(&s) {
            return Err(CoreError::EvalParse(format!("score {s} out of 1..=5")));
        }
    }
    Ok(e)
}

fn strict_extract<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T> {
    let start = raw.find('{').ok_or_else(|| CoreError::EvalParse("no json".into()))?;
    let end = raw.rfind('}').ok_or_else(|| CoreError::EvalParse("no json".into()))?;
    serde_json::from_str(&raw[start..=end]).map_err(|e| CoreError::EvalParse(e.to_string()))
}


#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct QuizResult {
    pub passed: bool,
    pub comment: String,
    #[serde(default)] pub new_weak_point: Option<WeakPointItem>,
}

/// 间隔复习快问结果解析(提取/严格规则同 parse_eval)。
pub fn parse_quiz(raw: &str) -> Result<QuizResult> {
    strict_extract(raw)
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_valid_eval() {
        let s = r#"评估如下:
```json
{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":3,"clarity":5},
 "summary":"整体清晰","weak_points":[{"title":"弹性vs斜率","detail":"混淆",
 "fixed_in_session":true,"anchor":{"chapter_href":"ch03.xhtml","hint":"第二节"}}],
 "final_restatement":"弹性是相对变化率……","observation_note":"倾向用比喻"}
```"#;
        let e = super::parse_eval(s).unwrap();
        assert_eq!(e.verdict, super::Verdict::PassSuggested);
        assert_eq!(e.scores.accuracy, 4);
        assert!(e.weak_points[0].fixed_in_session);
    }
    #[test]
    fn reject_out_of_range_score() {
        let s = r#"{"verdict":"pass_suggested","scores":{"accuracy":9,"completeness":3,"clarity":5},
 "summary":"x","final_restatement":"y"}"#;
        assert!(super::parse_eval(s).is_err());
    }
    #[test]
    fn reject_unknown_field() {
        let s = r#"{"verdict":"pass_suggested","scores":{"accuracy":4,"completeness":3,"clarity":5},
 "summary":"x","final_restatement":"y","extra":1}"#;
        assert!(super::parse_eval(s).is_err());
    }
}
