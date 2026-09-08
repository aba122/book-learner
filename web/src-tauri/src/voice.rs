//! 语音转写(TECH_DESIGN §8;M3 T3):whisper.cpp 本机模型,`feature = "voice"`(默认开启)。
//!
//! - 模型目录 `<data_root>/models/`,只认 `ggml-*.bin`;导入 = 校验后复制进目录(临时文件 + rename);
//!   删除只删该目录内的白名单文件;当前选择写 `setting.voiceModel`(直读表,不进 `AppSettings`)。
//! - 转写输入为 16 kHz 单声道 i16 PCM(前端重采样后经原始请求体上传);模型实例按路径懒加载并缓存,
//!   转写串行化(同一时间只跑一个 whisper)。
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use book_learner_core::CoreError;

use crate::error::IpcError;
use crate::state::AppState;

pub const MODELS_DIR_NAME: &str = "models";
pub const SETTING_KEY: &str = "voiceModel";
pub const DEFAULT_MODEL: &str = "large-v3-turbo-q5_0";
/// 已知模型(名称,文件名,说明);其它 `ggml-*.bin` 也接受,名称取自文件名去前缀后缀
pub const KNOWN_MODELS: &[(&str, &str, &str)] = &[
    (
        "large-v3-turbo-q5_0",
        "ggml-large-v3-turbo-q5_0.bin",
        "中文效果好,约 570 MB",
    ),
    ("small", "ggml-small.bin", "更快,约 480 MB"),
    ("base", "ggml-base.bin", "最快,约 150 MB,中文一般"),
];
/// 模型文件最小体积(防止把错误文件当模型)
pub const MIN_MODEL_BYTES: u64 = 20 * 1024 * 1024;
/// 单次转写最长音频(秒),与前端录音上限一致
pub const MAX_AUDIO_SECS: usize = 120;
pub const SAMPLE_RATE: usize = 16_000;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelDto {
    pub name: String,
    pub file: String,
    pub note: String,
    pub present: bool,
    pub bytes: Option<u64>,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    pub text: String,
    /// 音频时长(秒)
    pub seconds: f64,
    /// 转写耗时(秒)
    pub elapsed: f64,
    pub model: String,
}

pub fn models_dir(state: &AppState) -> PathBuf {
    state.data_root().join(MODELS_DIR_NAME)
}

fn model_name_from_file(file: &str) -> Option<String> {
    let stem = file.strip_prefix("ggml-")?.strip_suffix(".bin")?;
    if stem.is_empty()
        || !stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return None;
    }
    Some(stem.to_string())
}

fn file_for(name: &str) -> String {
    format!("ggml-{name}.bin")
}

pub fn selected_model(state: &AppState) -> Result<String, IpcError> {
    let stored: Option<String> = state.with_connection(|connection| {
        Ok(connection
            .query_row(
                "SELECT value FROM setting WHERE key=?1",
                [SETTING_KEY],
                |r| r.get(0),
            )
            .ok())
    })?;
    Ok(stored
        .filter(|v| model_name_from_file(&file_for(v)).is_some())
        .unwrap_or_else(|| DEFAULT_MODEL.to_string()))
}

/// 模型清单:已知模型 + 目录里的其它 `ggml-*.bin`
pub fn list(state: &AppState) -> Result<Vec<VoiceModelDto>, IpcError> {
    let dir = models_dir(state);
    let selected = selected_model(state)?;
    let mut out: Vec<VoiceModelDto> = KNOWN_MODELS
        .iter()
        .map(|(name, file, note)| {
            let bytes = std::fs::metadata(dir.join(file)).ok().map(|m| m.len());
            VoiceModelDto {
                name: name.to_string(),
                file: file.to_string(),
                note: note.to_string(),
                present: bytes.is_some(),
                bytes,
                selected: *name == selected,
            }
        })
        .collect();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if out.iter().any(|m| m.file == file) {
                continue;
            }
            let Some(name) = model_name_from_file(&file) else {
                continue;
            };
            let bytes = entry.metadata().ok().map(|m| m.len());
            out.push(VoiceModelDto {
                selected: name == selected,
                name,
                file,
                note: "自定义模型".into(),
                present: true,
                bytes,
            });
        }
    }
    Ok(out)
}

/// 导入模型文件:必须是 `ggml-*.bin`、≥ MIN_MODEL_BYTES;复制进模型目录(临时文件 + rename)。
pub fn import(state: &AppState, source: &Path) -> Result<VoiceModelDto, IpcError> {
    let file = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = model_name_from_file(&file).ok_or_else(|| {
        IpcError::invalid_request(
            "模型文件名必须形如 ggml-<名称>.bin",
            format!("bad model file name {file:?}"),
        )
    })?;
    let bytes = std::fs::metadata(source)
        .map_err(|error| IpcError::invalid_request("模型文件不存在或不可读", format!("{error}")))?
        .len();
    if bytes < MIN_MODEL_BYTES {
        return Err(IpcError::invalid_request(
            "模型文件太小,不像 whisper 模型",
            format!("model {file} is {bytes} bytes"),
        ));
    }
    let dir = models_dir(state);
    std::fs::create_dir_all(&dir).map_err(|error| IpcError::from(CoreError::Io(error)))?;
    let target = dir.join(&file);
    if target != source {
        let tmp = dir.join(format!("{file}.tmp"));
        std::fs::copy(source, &tmp).map_err(|error| IpcError::from(CoreError::Io(error)))?;
        std::fs::rename(&tmp, &target).map_err(|error| IpcError::from(CoreError::Io(error)))?;
    }
    // 首个导入的模型自动选中
    if list(state)?.iter().filter(|m| m.present).count() == 1 {
        set_selected(state, &name)?;
    }
    list(state)?
        .into_iter()
        .find(|m| m.name == name)
        .ok_or_else(|| IpcError::internal("imported model missing from list"))
}

pub fn delete(state: &AppState, name: &str) -> Result<Vec<VoiceModelDto>, IpcError> {
    let file = file_for(name);
    if model_name_from_file(&file).is_none() {
        return Err(IpcError::invalid_request(
            "模型名无效",
            format!("bad model name {name:?}"),
        ));
    }
    let path = models_dir(state).join(&file);
    if !path.is_file() {
        return Err(IpcError::from(CoreError::NotFound(format!(
            "voice model {} not present",
            path.display()
        ))));
    }
    invalidate_cache(&path);
    std::fs::remove_file(&path).map_err(|error| IpcError::from(CoreError::Io(error)))?;
    list(state)
}

pub fn set_selected(state: &AppState, name: &str) -> Result<Vec<VoiceModelDto>, IpcError> {
    let file = file_for(name);
    if model_name_from_file(&file).is_none() {
        return Err(IpcError::invalid_request(
            "模型名无效",
            format!("bad model name {name:?}"),
        ));
    }
    if !models_dir(state).join(&file).is_file() {
        return Err(IpcError::invalid_request(
            "该模型尚未导入",
            format!("model {name} not present"),
        ));
    }
    state.with_connection(|connection| {
        connection.execute(
            "INSERT OR REPLACE INTO setting(key,value) VALUES(?1,?2)",
            [SETTING_KEY, name],
        )?;
        Ok(())
    })?;
    list(state)
}

/// 把 16 kHz 单声道 i16 小端 PCM 转成 whisper 需要的 f32(-1..1)
pub fn pcm_i16_to_f32(bytes: &[u8]) -> Result<Vec<f32>, IpcError> {
    if bytes.len() % 2 != 0 {
        return Err(IpcError::invalid_request(
            "音频数据长度不是 16 位样本的整数倍",
            format!("odd pcm length {}", bytes.len()),
        ));
    }
    let samples = bytes.len() / 2;
    if samples == 0 {
        return Err(IpcError::invalid_request("没有录到声音", "empty pcm"));
    }
    if samples > MAX_AUDIO_SECS * SAMPLE_RATE {
        return Err(IpcError::invalid_request(
            "录音超过 2 分钟,请分段",
            format!("{samples} samples"),
        ));
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect())
}

/// 简易百分号解码(头部只能是 ASCII,提示词由前端 `encodeURIComponent`)
pub fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let (Some(h), Some(l)) = (
                hex(bytes.get(i + 1).copied()),
                hex(bytes.get(i + 2).copied()),
            ) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: Option<u8>) -> Option<u8> {
    match b? {
        c @ b'0'..=b'9' => Some(c - b'0'),
        c @ b'a'..=b'f' => Some(c - b'a' + 10),
        c @ b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(feature = "voice")]
struct Loaded {
    path: PathBuf,
    context: whisper_rs::WhisperContext,
}

#[cfg(feature = "voice")]
fn cache() -> &'static Mutex<Option<Loaded>> {
    static CACHE: std::sync::OnceLock<Mutex<Option<Loaded>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

#[cfg(feature = "voice")]
fn invalidate_cache(path: &Path) {
    if let Ok(mut slot) = cache().lock() {
        if slot.as_ref().is_some_and(|l| l.path == path) {
            *slot = None;
        }
    }
}

#[cfg(not(feature = "voice"))]
fn invalidate_cache(_path: &Path) {}

/// 转写:模型按当前选择懒加载;`lang` 为 whisper 语言码(默认 zh);`hint` 作为 initial prompt(当前块标题)。
#[cfg(feature = "voice")]
pub fn transcribe(
    state: &AppState,
    pcm: &[f32],
    lang: &str,
    hint: &str,
) -> Result<TranscriptDto, IpcError> {
    use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};
    let name = selected_model(state)?;
    let path = models_dir(state).join(file_for(&name));
    if !path.is_file() {
        return Err(IpcError::invalid_request(
            "还没有可用的语音模型,请先在设置页导入",
            format!("model {name} not present"),
        ));
    }
    let started = std::time::Instant::now();
    let mut slot = cache()
        .lock()
        .map_err(|_| IpcError::internal("voice cache poisoned"))?;
    if slot.as_ref().is_none_or(|l| l.path != path) {
        let context =
            WhisperContext::new_with_params(&path, WhisperContextParameters::default())
                .map_err(|error| IpcError::internal(format!("whisper load failed: {error:?}")))?;
        *slot = Some(Loaded {
            path: path.clone(),
            context,
        });
    }
    let loaded = slot.as_ref().expect("just loaded");
    let mut whisper_state = loaded
        .context
        .create_state()
        .map_err(|error| IpcError::internal(format!("whisper state failed: {error:?}")))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let lang = if lang.is_empty() { "zh" } else { lang };
    params.set_language(Some(lang));
    params.set_translate(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_print_special(false);
    params.set_suppress_blank(true);
    params.set_n_threads(
        std::thread::available_parallelism()
            .map(|n| n.get() as i32)
            .unwrap_or(4)
            .min(8),
    );
    if !hint.trim().is_empty() {
        params.set_initial_prompt(hint.trim());
    }
    whisper_state
        .full(params, pcm)
        .map_err(|error| IpcError::internal(format!("whisper failed: {error:?}")))?;
    let mut text = String::new();
    for i in 0..whisper_state.full_n_segments() {
        let Some(segment) = whisper_state.get_segment(i) else {
            continue;
        };
        if let Ok(piece) = segment.to_str_lossy() {
            text.push_str(piece.trim());
        }
    }
    Ok(TranscriptDto {
        text: text.trim().to_string(),
        seconds: pcm.len() as f64 / SAMPLE_RATE as f64,
        elapsed: started.elapsed().as_secs_f64(),
        model: name,
    })
}

#[cfg(not(feature = "voice"))]
pub fn transcribe(
    _state: &AppState,
    _pcm: &[f32],
    _lang: &str,
    _hint: &str,
) -> Result<TranscriptDto, IpcError> {
    Err(IpcError::invalid_request(
        "本构建未启用语音转写",
        "voice feature disabled",
    ))
}
