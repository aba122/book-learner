use crate::{CoreError, Result};
use serde::Deserialize;

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    PassSuggested,
    RelearnSuggested,
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct Scores {
    pub accuracy: u8,
    pub completeness: u8,
    pub clarity: u8,
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct Anchor {
    pub chapter_href: String,
    pub hint: String,
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct WeakPointItem {
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub fixed_in_session: bool,
    #[serde(default)]
    pub anchor: Option<Anchor>,
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct EvalResult {
    pub verdict: Verdict,
    pub scores: Scores,
    pub summary: String,
    #[serde(default)]
    pub weak_points: Vec<WeakPointItem>,
    pub final_restatement: String,
    #[serde(default)]
    pub observation_note: String,
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
    let start = raw
        .find('{')
        .ok_or_else(|| CoreError::EvalParse("no json".into()))?;
    let end = raw
        .rfind('}')
        .ok_or_else(|| CoreError::EvalParse("no json".into()))?;
    serde_json::from_str(&raw[start..=end]).map_err(|e| CoreError::EvalParse(e.to_string()))
}

#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct QuizResult {
    pub passed: bool,
    pub comment: String,
    #[serde(default)]
    pub new_weak_point: Option<WeakPointItem>,
}

/// 间隔复习快问结果解析(提取/严格规则同 parse_eval)。
pub fn parse_quiz(raw: &str) -> Result<QuizResult> {
    strict_extract(raw)
}

fn strict_extract_array<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T> {
    let start = raw
        .find('[')
        .ok_or_else(|| CoreError::EvalParse("no json array".into()))?;
    let end = raw
        .rfind(']')
        .ok_or_else(|| CoreError::EvalParse("no json array".into()))?;
    if end < start {
        return Err(CoreError::EvalParse("no json array".into()));
    }
    serde_json::from_str(&raw[start..=end]).map_err(|e| CoreError::EvalParse(e.to_string()))
}

/// 6.1 阶段 A 候选;`source_section` 形如 `"{href}#{小节标题}"`。
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct ChapterCandidate {
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub prereq_titles: Vec<String>,
    pub source_section: String,
}
pub fn parse_chapter_candidates(raw: &str) -> Result<Vec<ChapterCandidate>> {
    strict_extract_array(raw)
}

/// 6.1 阶段 B 草图。
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct DraftBlock {
    pub title: String,
    #[serde(default)]
    pub summary: String,
    pub source_sections: Vec<String>,
    #[serde(default)]
    pub prereqs: Vec<String>,
}
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct DraftModule {
    pub name: String,
    pub blocks: Vec<DraftBlock>,
}
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct DraftMap {
    pub modules: Vec<DraftModule>,
}
pub fn parse_draft_map(raw: &str) -> Result<DraftMap> {
    strict_extract(raw)
}

/// 6.4 迁移应用题结果(prompt only)。
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct ApplicationResult {
    pub passed: bool,
    pub comment: String,
}
pub fn parse_application_result(raw: &str) -> Result<ApplicationResult> {
    strict_extract(raw)
}

/// 6.5 方法论片段(prompt only)。
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct MethodologyFragment {
    pub markdown: String,
    pub source_block: String,
}
pub fn parse_methodology_fragment(raw: &str) -> Result<MethodologyFragment> {
    strict_extract(raw)
}

/// 6.6 讨论整理稿(prompt only)。
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct DiscussionNote {
    pub markdown: String,
    pub used_facts: bool,
}
pub fn parse_discussion_note(raw: &str) -> Result<DiscussionNote> {
    strict_extract(raw)
}

/// 6.8 整书终评报告(prompt only)。
#[derive(Debug, serde::Serialize, Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
pub struct FinalReport {
    pub overall: u8,
    pub strongest_module: String,
    pub weakest_module: String,
    pub report_markdown: String,
}
pub fn parse_final_report(raw: &str) -> Result<FinalReport> {
    let r: FinalReport = strict_extract(raw)?;
    if !(1..=5).contains(&r.overall) {
        return Err(CoreError::EvalParse(format!(
            "overall {} out of 1..=5",
            r.overall
        )));
    }
    Ok(r)
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

    #[test]
    fn parse_chapter_candidates_array_strict() {
        let raw = r#"候选如下:
```json
[{"title":"需求弹性","summary":"相对变化率","prereq_titles":["需求曲线"],"source_section":"ch03.xhtml#3.1 弹性"}]
```"#;
        let v = super::parse_chapter_candidates(raw).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].source_section, "ch03.xhtml#3.1 弹性");
        assert!(super::parse_chapter_candidates(
            r#"[{"title":"x","summary":"y","source_section":"a","extra":1}]"#
        )
        .is_err());
        assert!(super::parse_chapter_candidates("no array here").is_err());
    }
    #[test]
    fn parse_draft_map_strict() {
        let raw = r#"{"modules":[{"name":"供给与需求","blocks":[{"title":"需求弹性","summary":"s","source_sections":["ch03.xhtml#3.1"],"prereqs":[]}]}]}"#;
        let d = super::parse_draft_map(raw).unwrap();
        assert_eq!(d.modules[0].blocks[0].title, "需求弹性");
        assert!(super::parse_draft_map(r#"{"modules":[],"oops":1}"#).is_err());
    }
    #[test]
    fn parse_post_pass_results_strict() {
        let a = super::parse_application_result(r#"{"passed":true,"comment":"思路正确"}"#).unwrap();
        assert!(a.passed);
        assert!(super::parse_application_result(r#"{"passed":true,"comment":"c","x":1}"#).is_err());
        let m = super::parse_methodology_fragment(
            r#"{"markdown":"我的版本:先问情境","source_block":"供需弹性"}"#,
        )
        .unwrap();
        assert_eq!(m.source_block, "供需弹性");
        assert!(super::parse_methodology_fragment(r#"{"markdown":"x"}"#).is_err());
        let d = super::parse_discussion_note(r#"{"markdown":"…","used_facts":false}"#).unwrap();
        assert!(!d.used_facts);
        assert!(super::parse_discussion_note(r#"{"markdown":"…","used_facts":"no"}"#).is_err());
        let f = super::parse_final_report(r##"{"overall":4,"strongest_module":"a","weakest_module":"b","report_markdown":"# 报告"}"##).unwrap();
        assert_eq!(f.overall, 4);
        assert!(super::parse_final_report(
            r#"{"overall":7,"strongest_module":"a","weakest_module":"b","report_markdown":"r"}"#
        )
        .is_err());
    }
}
