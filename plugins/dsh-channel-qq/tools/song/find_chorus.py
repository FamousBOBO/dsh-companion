"""定位一首歌的「副歌」起点，只输出一份固定形状的 JSON。

为什么单独一个独立脚本（而不是写进插件的 TS 里）：
谱分析要用 numpy + librosa，而插件的运行时不带 Python 依赖。把它做成一个
**能独立跑**的命令行工具，好处是三重的——可以拿陌生歌手工试、可以在
`adapters/song/chorus.ts` 之外复现同一结果、也允许以后换实现（换成别的算法
只要输出形状不变，那边一行都不用改）。

用法：
    python find_chorus.py --input song.wav --out chorus.json [--seconds 25]
    python find_chorus.py --input song.wav --out chorus.json --start-at 0 --seconds 180

`--start-at <秒>`：**起点由调用方给定**（"从头开始放"就是 0）。传了它之后跳过
重复段落/副歌搜索与人声对齐，`start` 直接等于它，`confidence` 固定 1.0、
`method` 标 `manual-start`——这不是"猜"出来的结果，所以不伪装成定位置信度。
句尾（`phraseEnds`）仍然从该点之后算，因为上层还是要收在一句歌词结束处。
默认不传 = 原来的行为一字不变。

输出（成功）：
    {"ok": true, "start": 62.5, "end": 92.0, "confidence": 0.71,
     "method": "repeat+energy", "repeats": 2, "vocalRatio": 0.83,
     "phraseEnds": [78.0, 84.5, 91.0, 97.5]}

`phraseEnds` 是副歌起点之后**每一句唱完的位置**（换气/句间停顿，绝对秒数、升序）。
上层拿它把语音条收在句尾而不是硬切在整秒上；判据见下面第 5 段。

输出（失败）：
    {"ok": false, "reason": "..."}

## 算法（三段，每段都对应一个"为什么"）

1. **色度（chroma）自相似 → 重复段落**。
   副歌的定义性特征是「同一段旋律在后半首歌里又出现一次」，而旋律的
   平移不变表征就是色度（12 个半音类的能量）。每 0.5 s 一帧、12 维、
   逐列 L2 归一化（只留"唱的是哪几个音"，丢掉响度）。
   然后对每个滞后 `lag`，算 `chroma[t] · chroma[t+lag]` 在长 `seg` 窗口里的
   均值——这就是"这段旋律在 lag 秒之后又出现了一遍"的分数。
   **限制 `lag >= seg`**：不这样限制的话，25 s 的窗口和 14 s 之后的窗口
   有 11 s 是重叠的，相似度天然接近 1，选出来的"重复"其实是它自己。
   实测（`wo_bu_nan_guo` 320 s / 周杰伦 258 s）不限制时会稳定选到
   lag≈14 s 的假重复。

2. **人声活动（vocalRatio）→ 排除纯伴奏段**。
   副歌是**唱的**。这里用两个互补的量，各自按全曲 10–90 分位归一化到 0..1：
      - 宽带 RMS（`librosa.feature.rms`）：盖住整条人声频带的能量起伏；
      - 1–4 kHz 带内能量：中文流行歌的人声基频与第一共振峰主要落在这里。
   为什么不用 `librosa.beat`（虽然题面允许）：节拍在伴奏里最强，副歌段与
   主歌段的 beat 强度差别不大，用它当"人声判据"等于用伴奏判人声。
   为什么 RMS 权重更高：拿同一首歌的**分离人声 stem**做真值（能量高出
   底噪 12 dB 记为"在唱"），实测每帧相关度 RMS-dB 0.75、1–4 kHz 带 0.67、
   而"1–4 kHz 占总能量的比例"是 **-0.15**（伴奏里的镲片/高频噪声把它拉反了）。
   所以用带内**绝对**能量的分位归一，而不是"占比"。

3. **重复次数 + 相似度 → confidence**。
   `confidence` 必须是判据的函数，不能写死：这里
   `sim_score = (sim - 0.50) / 0.35`（0.50 分位以下算 0，0.85 以上算 1）、
   `vocal_score = (vocalRatio - 0.25) / 0.50`、`repeat_score = (repeats - 1) / 2`，
   加权 0.45 / 0.35 / 0.20。权重偏向相似度是因为"重复"是副歌的必要条件，
   而人声比例只用来在两个都重复的段落之间排序（例如副歌 vs 副歌前的过门）。
   上层以 0.55 为阈值拒绝，本脚本不替上层做这个决定。

4. **人声起点对齐（`align_vocal_start`）**。
   第 1 步给出的是"重复段落的**相似度峰值**"，而相似度曲线的峰顶通常在整段中间，
   所以起点会落在副歌前一句上（实测 `wo_bu_nan_guo` 早 11–14 s、周杰伦那首早 21 s）。
   修正只做一件事：在 `[start, start + min(20, 段长)]` 内找**第一次"从低到高、
   并持续 ≥1.5 s"的人声抬升**，把起点挪到那一帧。
   三个判据都取自这一段自己的分布（20 分位=段内静音基线，80 分位=段内"在唱"，
   阈值取中点）；"抬升"还要求抬升点之前 2 s 内出现过低于阈值的帧，
   否则那只是"本来就在唱"——那样的对齐等于把起点随手往后挪一两帧，不是修正。
   为什么上限是 `min(20, 段长)` 而不是 `段长/2`：25 s 的段只有 12.5 s 时，
   实测 `wo_bu_nan_guo` 的副歌人声在峰值之后 **16 s** 才连续抬起来，窗口在数学上够不着——
   那不是判据不准，是窗口装不下。20 s 这个绝对上限本身就是"不许挪进主歌"的护栏。
   **对齐只修正位置，不参与置信度**：`confidence` 用的是对齐前的判据，
   对齐成功不会让它变高——那是伪造证据。发生对齐时 `method` 变成
   `repeat+energy+vocal-align`，诊断里另有 `startBeforeAlign` / `startAfterAlign`。
   两条护栏：新起点必须仍在原窗口内，且新起点之后还剩整 `seconds` 秒可裁
   （宁可起点早一点，也不要裁出一条短语音）。

5. **句尾（`phraseEnds`）：人声曲线"下凹再回升"的位置**。
   语音条如果按整秒硬切，切点通常落在半个词或一句中间；而换气处本来就是句子之间，
   切在那里像自然停顿。所以这里给出**候选收尾点**，让上层按"不超过上限的最后一个"
   自己挑（本脚本不替上层决定语音条多长）。
   判据全部取自这一段自己的分布，没有和某首歌绑定的常量：
     - 阈值 = 段内 20 分位（这一段里的静音基线）与 70 分位（这一段里的"在唱"水平）
       之间 `PHRASE_DIP_FRAC`（45%）处——固定绝对值换一首歌就会失效（轻声歌整体低、
       摇滚整体高），而分位差本身就是"这首歌这一段自己的动态范围"；
     - "下凹" = 曲线**从阈值之上跌到阈值之下**的那一帧（不是"低电平持续多久"，
       后者会把一整段间奏吞进去）；
     - "是换气不是收场" = 跌下去之后 `PHRASE_REBOUND_SEC` 秒内又回到高位，
       且跌之前 `PHRASE_BACK_SEC` 秒里确实到过高位。缺了这两条，副歌唱完之后的
       长静音、以及一记重音之后的单个低帧都会被当成句尾；
     - 曲线起伏太小（段内高低差 < `PHRASE_MIN_SPAN`）时返回**空列表**：清唱/电音/
       纯器乐没有可信的句间下凹，这时诚实地说"没找到"，让上层退回硬切。
   看多远由 `horizon_for()` 决定：`min(max(90, seconds + 30), 240)`。90 s 是基线
   （语音条有上限，更远的句尾用不上，而把它们算进来只会把分位统计拖偏）；语音条上限
   提到 180 s 之后需要"需要的长度 + 30 s"才收得到最后一句；240 s 封顶是因为再远的
   "下凹"多半已经是间奏或下一段主歌了。实际视界在 `--diag` 的 `phraseHorizonSec` 里。

## `--start-at`：起点由调用方给的模式（"从头开始放"）

操作员的要求里有一种"从头开始放"，那种情况下副歌搜索的结论一定会被起点 0 覆盖掉。
所以这个模式**跳过第 1–4 段**（重复段落搜索、相似度打分、聚类、人声对齐），把
`start` 直接设为给定值，`confidence` 固定 `1.0`、`method` 标 `manual-start`
（这不是猜出来的定位，所以不伪装成定位置信度）。`end = start + 段长`，保持
`end - start == 段长` 这条不变式；`repeats` 给 0（没做过重复搜索，不能报次数）。
第 5 段（句尾）**照算**，而且 `--seconds` 参与视界伸缩——否则 0–180 s 的条
在 90 s 处就收不到句尾，只能硬切在上限上。

## 两个刻意的取舍

- **只看前 8 分钟**（`MAX_ANALYZE_SEC`）。副歌不会在最后；而 8 分钟的
  解码 + STFT 已经是 5–15 s 的量级，一首两小时的演唱会视频不该让用户等。
- **"最早出现的重复段落"而不是"分数最高的段落"**：同一段副歌通常出现 2–4 次，
  分数最高的那次往往在靠后（伴奏更满）。取最早的一次更接近"副歌第一次唱"，
  也避免了「语音条从桥段开始」。只有在分数差 5% 以内才允许往后挪，
  否则就是退而求其次——宁可把 `confidence` 说实话，也不假装定位成功。
"""

import argparse
import json
import sys
import time

import numpy as np
import librosa

# 每帧 0.5 s：再稀就拿不准 25 s 的边界，再密就只是多花时间（副歌边界本来也不精确）。
HOP_SEC = 0.5
FPS = 1.0 / HOP_SEC

# 只分析前 8 分钟（见文件头）。
MAX_ANALYZE_SEC = 480.0
SAMPLE_RATE = 22050

# 滞后范围（题面给的 8–90 s）；段长范围 15–40 s。
MIN_LAG_SEC = 8.0
MAX_LAG_SEC = 90.0
MIN_SEG_SEC = 15.0
MAX_SEG_SEC = 40.0

# 判据的刻度（见文件头第 3 段）。
SIM_FLOOR = 0.50
SIM_SPAN = 0.35
VOCAL_FLOOR = 0.25
VOCAL_SPAN = 0.50
REPEAT_SPAN = 2.0
WEIGHT_SIM = 0.45
WEIGHT_VOCAL = 0.35
WEIGHT_REPEAT = 0.20

# 候选门槛：绝对下限 0.60，或达到本曲最高分的 85%（不同歌的色度相似度
# 绝对值差异很大——实测最高分在 0.82–0.86，但纯器乐曲会低到 0.5 上下）。
CAND_FLOOR = 0.60
CAND_RELATIVE = 0.85
# "分数差 5% 以内就算并列"（见文件头取舍第二条）。
TIE_RATIO = 0.95
# 相邻候选合并成一个"段落"的最大间隔（秒）。
CLUSTER_GAP_SEC = 1.0

# 人声起点对齐（见文件头第 4 段）。
# 搜索窗上限：最多把 start 往前挪这么多秒。
#
# **为什么是 `min(20, 段长)` 而不是 `min(20, 段长/2)`**：段长 25 s 时后者只有 12.5 s，
# 而实测 `wo_bu_nan_guo` 的副歌人声真正开始于相似度峰值之后 **16 s**（峰值 76 s、
# 人声在 92 s 才连续抬起来），12.5 s 的窗口在数学上够不着它——那不是判据不准，
# 是窗口装不下。20 s 这个绝对上限本来就是"不许挪进主歌"的那条护栏，对 25 s 的段
# 仍然安全（挪 20 s 还在这一段里，且下面还有"必须剩整段可裁"的护栏）。
ALIGN_MAX_SEC = 20.0
# "持续"要多久才算一次真正的抬升：1.5 s（三个 0.5 s 帧）。
ALIGN_HOLD_SEC = 1.5
# "从低到高"的低：抬升点之前这段回看里必须出现过低于阈值的一帧，否则不算抬升
# （而是"本来就在唱"——把起点挪进去等于随手往后挪 0 秒，没有意义）。
ALIGN_LOOKBACK_SEC = 2.0

# 句尾检测（见文件头第 5 段）。
#
# 往后看多远：基线 90 s（59 s 时代的语音条留的余量）；实际用 `horizon_for()` 按
# `--seconds` 伸缩——180 s 的条要看到 210 s 才收得到最后一句。
PHRASE_HORIZON_SEC = 90.0
# 视界封顶：再远的"下凹"多半是间奏或下一段主歌，而且会把分位统计拖偏。
MAX_PHRASE_HORIZON_SEC = 240.0
# 视界多留多少余量：句尾必须能在"需要的长度"之后被看到，否则永远收不到那一句。
PHRASE_HORIZON_EXTRA_SEC = 30.0
# 段内高低差不到这个值时没有可信的"下凹"（清唱/电音/纯器乐），直接不给句尾。
PHRASE_MIN_SPAN = 0.12
# 阈值落在 20 分位（静音基线）与 70 分位（在唱）之间的这个比例上。
PHRASE_DIP_FRAC = 0.45
# "刚才还在唱 / 随后又唱起来"的高位：阈值到 70 分位之间的这个比例。
PHRASE_HIGH_FRAC = 0.6
# 回看多久算"刚才还在唱"、往后多久内必须重新唱起来（秒）。
PHRASE_BACK_SEC = 1.5
PHRASE_REBOUND_SEC = 2.0
# 两个句尾至少隔这么久：副歌里一句通常 3–6 s，半秒级的抖动不是句子边界。
PHRASE_MIN_GAP_SEC = 2.5


def percentile01(values, lo_p=10.0, hi_p=90.0):
    """按分位裁到 0..1。用分位而不是 min/max：单个爆音不该把整条曲线压扁。"""
    array = np.asarray(values, dtype=float)
    lo = float(np.percentile(array, lo_p))
    hi = float(np.percentile(array, hi_p))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        return np.zeros_like(array)
    return np.clip((array - lo) / (hi - lo), 0.0, 1.0)


def clamp01(value):
    return float(min(1.0, max(0.0, value)))


def horizon_for(seconds):
    """句尾看多远（秒）：`min(max(90, seconds + 30), 240)`（见文件头第 5 段）。

    为什么随 `--seconds` 伸缩：语音条的上限就是"要在这么远之内收一句"，而一个固定
    90 s 的视界会让 180 s 的条在 90 s 处就没有候选句尾了——那等于上限定成 180 也白搭。
    """
    return float(min(max(PHRASE_HORIZON_SEC, float(seconds) + PHRASE_HORIZON_EXTRA_SEC),
                     MAX_PHRASE_HORIZON_SEC))


def vocal_activity(y, sr, hop):
    """每帧的"像不像有人在唱"（0..1）。见文件头第 2 段。"""
    stft = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    power = stft ** 2
    band = (freqs >= 1000.0) & (freqs <= 4000.0)
    band_energy = np.sqrt(power[band, :].sum(axis=0))
    wide_energy = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    frames = min(len(band_energy), len(wide_energy))
    band_norm = percentile01(librosa.amplitude_to_db(band_energy[:frames] + 1e-9))
    wide_norm = percentile01(librosa.amplitude_to_db(wide_energy[:frames] + 1e-9))
    return 0.5 * band_norm + 0.5 * wide_norm


def repeat_map(chroma_unit, seg_frames, min_lag, max_lag):
    """每个 start 的 (最佳滞后, 最佳相似度)。返回 (starts, best_lag)。

    逐 lag 做向量化的滑窗均值：先把点积序列累积求和，再差分出 `seg_frames`
    长度的窗口均值——比"每个 start 每个 lag 都切一次数组"快两个数量级。
    """
    frames = chroma_unit.shape[1]
    starts = np.zeros(frames - seg_frames, dtype=float)
    best_lag = np.zeros(frames - seg_frames, dtype=int)
    for lag in range(min_lag, max_lag + 1):
        usable = frames - lag
        if usable < seg_frames:
            continue
        dots = np.sum(chroma_unit[:, :usable] * chroma_unit[:, lag:], axis=0)
        cumulative = np.concatenate([[0.0], np.cumsum(dots)])
        window_means = (cumulative[seg_frames:] - cumulative[:-seg_frames]) / seg_frames
        limit = min(len(window_means), len(starts))
        better = window_means[:limit] > starts[:limit]
        starts[:limit][better] = window_means[:limit][better]
        best_lag[:limit][better] = lag
    return starts, best_lag


def count_repeats(chroma_unit, start_frame, lag, seg_frames, threshold):
    """这一段总共出现了几次：从 2 开始（start 自己算第 1 次），往后数 lag 的整数倍。"""
    frames = chroma_unit.shape[1]
    repeats = 1
    for multiple in (1, 2, 3, 4):
        other = start_frame + lag * multiple
        if other + seg_frames > frames:
            break
        left = chroma_unit[:, start_frame:start_frame + seg_frames]
        right = chroma_unit[:, other:other + seg_frames]
        if float(np.mean(np.sum(left * right, axis=0))) < threshold:
            break
        repeats += 1
    return repeats


def confidence_of(similarity, vocal_ratio, repeats):
    """见文件头第 3 段：三个判据加权，低分不四舍五入成"看起来还行"。"""
    sim_score = clamp01((similarity - SIM_FLOOR) / SIM_SPAN)
    vocal_score = clamp01((vocal_ratio - VOCAL_FLOOR) / VOCAL_SPAN)
    repeat_score = clamp01((repeats - 1) / REPEAT_SPAN)
    total = WEIGHT_SIM * sim_score + WEIGHT_VOCAL * vocal_score + WEIGHT_REPEAT * repeat_score
    return round(total, 2)


def align_vocal_start(activity, start_frame, segment_sec):
    """在 `[start, start + cap]` 内找"人声真正开始"的那一帧（见文件头第 4 段）。

    返回 `(新起点帧, 阈值)`；没找到就返回 `(None, 阈值)`——调用方保持原 start。

    三个判据都从**这一段自己的分布**里取，没有写死的绝对值：
      - 阈值 = 段内人声量的 20 分位与 80 分位的中点（20 分位=这一段里的静音基线，
        80 分位=这一段里的"在唱"水平）。取中点而不是某个分位，是因为不同歌的
        人声量分布宽度差很多：固定分位在"伴奏重"的歌上会偏早、在"清唱"的歌上会偏晚；
      - "持续" = 连续 `ALIGN_HOLD_SEC` 秒都在阈值之上（单帧过阈只是换气/一个重音）；
      - "抬升" = 抬升点之前的 `ALIGN_LOOKBACK_SEC` 秒里必须出现过低于阈值的帧。
        没有这一条，一段从头到尾人声都不断的过门会被判成"起点在 0 偏后一点点"，
        对齐就退化成"把起点随手往后挪一两帧"——那不是修正，是假装修正。
    """
    cap_frames = int(round(min(ALIGN_MAX_SEC, segment_sec) * FPS))
    if cap_frames <= 0:
        return None, None
    # 阈值在**整段**（segment_sec）上统计，但**只允许挪 cap_frames**：这两件事是分开的。
    # 只用 cap 那段统计会让"静音基线"被窗口边界切掉一半（实测 `wo_bu_nan_guo` 窗口内
    # 人声量最低也有 0.31，20 分位被抬高到 0.73，于是任何一个正常重音都算"抬升"）。
    scope = activity[start_frame:start_frame + int(round(segment_sec * FPS))]
    if scope.size == 0:
        return None, None
    quiet = float(np.percentile(scope, 20))
    loud = float(np.percentile(scope, 80))
    threshold = 0.5 * (quiet + loud)
    hold_frames = max(1, int(np.ceil(ALIGN_HOLD_SEC * FPS)))
    lookback = int(round(ALIGN_LOOKBACK_SEC * FPS))

    for offset in range(0, cap_frames + 1):
        frame = start_frame + offset
        required = activity[frame:frame + hold_frames]
        if required.size < hold_frames:
            break  # 已经到音轨结尾，"持续"验证不了
        if not np.all(required >= threshold):
            continue
        earlier = activity[start_frame + max(0, offset - lookback):frame]
        if earlier.size == 0 or float(np.min(earlier)) >= threshold:
            continue
        return frame, round(float(threshold), 3)
    return None, round(float(threshold), 3)


def phrase_ends(activity, start_frame, horizon_sec):
    """副歌起点之后，人声"下凹再回升"的位置（秒，绝对时间，升序）。

    返回 `(点列表, 诊断)`。阈值与两个高位都从**这一段自己的分布**里算（见文件头第 5 段），
    所以换一首歌不需要改任何常量；段内起伏太平时返回空列表而不是硬找一个点。
    """
    scope_end = min(len(activity), start_frame + int(round(horizon_sec * FPS)))
    scope = activity[start_frame:scope_end]
    back = max(1, int(round(PHRASE_BACK_SEC * FPS)))
    rebound = max(1, int(round(PHRASE_REBOUND_SEC * FPS)))
    min_gap = max(1, int(round(PHRASE_MIN_GAP_SEC * FPS)))
    diagnostics = {"horizonSec": round(horizon_sec, 1), "frameStartsAt": round(start_frame / FPS, 1),
                   "frames": int(scope.size)}
    # 一段下凹要三段证据（之前的高位、阈值、之后的高位），帧数不够就别硬判。
    if scope.size < back + rebound + 2:
        diagnostics["reason"] = "副歌之后剩下的音频太短，判断不了句尾"
        return [], diagnostics
    quiet = float(np.percentile(scope, 20))
    loud = float(np.percentile(scope, 70))
    diagnostics["quiet"] = round(quiet, 3)
    diagnostics["loud"] = round(loud, 3)
    if loud - quiet < PHRASE_MIN_SPAN:
        diagnostics["reason"] = "段内人声活跃度起伏太小（清唱/电音或纯器乐），没有可信的句间下凹"
        return [], diagnostics
    dip = quiet + PHRASE_DIP_FRAC * (loud - quiet)
    high = dip + PHRASE_HIGH_FRAC * (loud - dip)
    diagnostics["dipThreshold"] = round(dip, 3)
    diagnostics["highLevel"] = round(high, 3)

    ends = []
    last = -min_gap
    for offset in range(back, scope.size):
        # 只认"第一帧越线"：否则一段低电平里每一帧都会被数成一个句尾。
        if not (scope[offset] < dip and scope[offset - 1] >= dip):
            continue
        before = scope[offset - back:offset]
        after = scope[offset:offset + rebound]
        if before.size == 0 or float(np.max(before)) < high:
            continue  # 刚才并没有在唱：这不是句间停顿，是伴奏里的安静处
        if after.size == 0 or float(np.max(after)) < high:
            continue  # 之后没再唱起来：那是副歌收场，不是一句唱完
        if offset - last < min_gap:
            continue  # 同一次换气的抖动，只算一个句尾
        last = offset
        ends.append(round((start_frame + offset) / FPS, 1))
    diagnostics["candidates"] = list(ends)
    return ends, diagnostics


def manual_start(start_at, duration, activity, segment_sec, horizon, started):
    """`--start-at`：起点由调用方给（见文件头那一节）。返回 (结果 dict, 诊断 dict)。"""
    # 起点夹到 `[0, duration-1]`：负数会让上层裁出"从结尾开始"的空文件，
    # 而 `--start-at` 本身的值仍然优先（0 就是 0，不会被这里挪动）。
    start = float(min(max(start_at, 0.0), max(0.0, duration - 1.0)))
    start_frame = int(round(start * FPS))
    end = float(min(start + segment_sec, duration))
    scope = activity[start_frame:start_frame + int(round(segment_sec * FPS))]
    # 人声比例照算（这是"这一段里有多少帧在唱"的测量，不是猜），只是不参与置信度。
    vocal = float(np.mean(scope)) if scope.size > 0 else 0.0
    ends, phrase_diag = phrase_ends(activity, start_frame, horizon)
    diagnostics = {
        "durationSec": round(duration, 1),
        "startAt": round(start, 1),
        "segmentSec": round(segment_sec, 1),
        "vocalRatio": round(vocal, 4),
        "phraseHorizonSec": round(horizon, 1),
        "phraseEnds": ends,
        "phrase": phrase_diag,
        "elapsedSec": round(time.time() - started, 2),
    }
    return {
        "ok": True,
        "start": round(start, 1),
        "end": round(end, 1),
        # 起点是给定的，不是判出来的：1.0 表示"这条路径不产生定位不确定性"，
        # 而 `method` 写明它来自 `--start-at`，免得诊断把 1.0 当成"猜得很准"。
        "confidence": 1.0,
        "method": "manual-start",
        # 没做重复搜索就没有重复次数可说：给 0，不编一个"1 次"。
        "repeats": 0,
        "vocalRatio": round(vocal, 2),
        "phraseEnds": ends,
    }, diagnostics


def locate(path, seconds, align=True, start_at=None, need=None):
    """主流程。返回 (结果 dict, 诊断 dict)。"""
    started = time.time()
    y, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True, duration=MAX_ANALYZE_SEC)
    if y is None or len(y) == 0:
        return {"ok": False, "reason": "音频是空的（解码不出任何采样）"}, {}
    duration = len(y) / float(sr)
    hop = int(sr * HOP_SEC)
    segment_sec = float(min(max(seconds, MIN_SEG_SEC), MAX_SEG_SEC))
    # 句尾视界按"这条语音条最多多长"伸缩（`--need`），没有它才退回 `--seconds`。
    # 两者刻意分开：`--seconds` 同时是副歌段长（参与重复段落检测），拿 180 去当段长
    # 会把"找哪一段"的判据整个改掉；而视界只决定"往后看多远找句尾"。
    horizon = horizon_for(seconds if need is None else max(float(seconds), float(need)))

    # 人声活动在第 2、4、5 段都要用，先算好：`--start-at` 模式只需要它（与句尾）。
    activity = vocal_activity(y, sr, hop)
    if start_at is not None:
        return manual_start(start_at, duration, activity, segment_sec, horizon, started)

    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=hop, n_fft=2048)
    units = np.linalg.norm(chroma, axis=0)
    units[units == 0] = 1.0
    chroma_unit = chroma / units
    frames = chroma_unit.shape[1]

    seg_frames = int(round(segment_sec * FPS))
    # lag >= seg_frames：不与自己重叠（见文件头第 1 段那条实测）。
    min_lag = int(max(round(MIN_LAG_SEC * FPS), seg_frames))
    max_lag = int(min(round(MAX_LAG_SEC * FPS), frames - seg_frames - 1))
    if max_lag <= min_lag:
        return {
            "ok": False,
            "reason": f"音轨太短（{duration:.1f}s），放不下 {segment_sec:.0f}s 的重复窗口",
        }, {}

    similarity, best_lag = repeat_map(chroma_unit, seg_frames, min_lag, max_lag)
    peak = float(similarity.max()) if similarity.size > 0 else 0.0
    if peak <= 0.0:
        return {"ok": False, "reason": "整首歌没有找到任何重复窗口（可能是纯器乐/音效）"}, {}

    threshold = max(CAND_FLOOR, CAND_RELATIVE * peak)
    candidate_frames = np.where(similarity >= threshold)[0]
    if candidate_frames.size == 0:
        return {"ok": False, "reason": f"最高相似度 {peak:.2f} 仍低于门槛 {threshold:.2f}"}, {}

    clustered = _cluster(candidate_frames)
    passages = []
    for group in clustered:
        best = None
        for frame in group:
            index = int(frame)
            vocal = float(np.mean(activity[index:index + seg_frames])) if index + seg_frames <= len(activity) else 0.0
            lag = int(best_lag[index])
            repeats = count_repeats(chroma_unit, index, lag, seg_frames, threshold)
            score = float(similarity[index]) * (0.6 + 0.4 * vocal) * (1.0 + 0.15 * (repeats - 1))
            item = {
                "start": round(index / FPS, 1),
                "lag": round(lag / FPS, 1),
                "sim": round(float(similarity[index]), 4),
                "vocal": round(vocal, 4),
                "repeats": repeats,
                "score": round(score, 4),
            }
            if best is None or item["score"] > best["score"]:
                best = item
        if best is not None:
            passages.append(best)

    if not passages:
        return {"ok": False, "reason": "候选段落聚类后为空"}, {}
    passages.sort(key=lambda item: -item["score"])
    top_score = passages[0]["score"]
    # 并列（差 5% 以内）时取**最早**的那次（见文件头取舍第二条）。
    tied = [item for item in passages if item["score"] >= TIE_RATIO * top_score]
    picked = min(tied, key=lambda item: (item["start"], -item["score"]))

    start = float(picked["start"])
    end_before = float(min(start + segment_sec, duration))
    confidence = confidence_of(picked["sim"], picked["vocal"], picked["repeats"])

    # 第 4 段：把起点对齐到"人声真正开始"的那一帧（见文件头与 align_vocal_start）。
    aligned_frame, align_threshold = (align_vocal_start(activity, int(round(start * FPS)), segment_sec)
                                     if align else (None, None))
    aligned_start = start
    aligned = False
    if aligned_frame is not None:
        candidate = aligned_frame / FPS
        # 两条护栏（提示里的"不要超出原来的 end"与"宁可早也不要短"）：
        # ① 新起点必须仍在原窗口内（`candidate < end_before`）——对齐只往"里"挪，不越过段尾；
        # ② 新起点之后必须还剩整整 `segment_sec` 秒的音频可裁。
        #    这里的判据是**音轨剩余长度**而不是 `end_before - candidate`：后者恒小于
        #    `segment_sec`（因为 candidate > start 且 end_before = start + segment_sec），
        #    照字面写等于"对齐永不生效"。而语音条是按 `chorusStart` 往后裁 `seconds` 的，
        #    真正需要保证的正是"后面还有 `seconds` 那么长"——就是这一条。
        if candidate < end_before and (duration - candidate) >= segment_sec:
            aligned_start = candidate
            aligned = True
    # `end` 跟着起点走，保持 `end - start == segment_sec` 这条不变式：上层用它判
    # "够不够一段"。对齐前后两个 end 都留在诊断里，谁想核对都能看到。
    end_after = float(min(aligned_start + segment_sec, duration))

    # 第 5 段：副歌起点之后的人声句尾（上层据此把语音条收在句子结束处）。
    # 视界随 `--seconds` 伸缩：180 s 的条要看到 210 s 才收得到最后一句。
    ends, phrase_diag = phrase_ends(activity, int(round(aligned_start * FPS)), horizon)

    diagnostics = {
        "durationSec": round(duration, 1),
        "peak": round(peak, 4),
        "threshold": round(threshold, 4),
        "segmentSec": round(segment_sec, 1),
        "lagRangeSec": [round(min_lag / FPS, 1), round(max_lag / FPS, 1)],
        "passages": passages[:6],
        # 对齐前后的起点与终点都留着：以后排查"为什么这次偏了"，看这四个数就够。
        "startBeforeAlign": round(start, 1),
        "startAfterAlign": round(aligned_start, 1),
        "endBeforeAlign": round(end_before, 1),
        "endAfterAlign": round(end_after, 1),
        "alignThreshold": align_threshold,
        "alignCapSec": round(min(ALIGN_MAX_SEC, segment_sec), 1),
        # 句尾这条：阈值、高位、候选点都留着（"为什么这条语音条只有 47.5 s"看这里）。
        "phraseEnds": ends,
        "phraseHorizonSec": round(horizon, 1),
        "phrase": phrase_diag,
        "elapsedSec": round(time.time() - started, 2),
    }
    return {
        "ok": True,
        "start": round(aligned_start, 1),
        "end": round(end_after, 1),
        "confidence": confidence,
        # `method` 是对齐发生没发生的唯一标记：诊断时一眼看出"这次到底调没调"。
        "method": "repeat+energy+vocal-align" if aligned else "repeat+energy",
        "repeats": int(picked["repeats"]),
        "vocalRatio": round(float(picked["vocal"]), 2),
        # 句尾给不出的可能是"这段太平"，不是脚本坏了：给空数组而不是让上层猜。
        "phraseEnds": ends,
    }, diagnostics


def _cluster(frames):
    """把相邻候选帧并成一个段落（副歌是一整段，不是一堆散点）。"""
    gap = int(round(CLUSTER_GAP_SEC * FPS))
    groups = []
    for frame in frames:
        if groups and int(frame) - groups[-1][-1] <= gap:
            groups[-1].append(int(frame))
        else:
            groups.append([int(frame)])
    return groups


def main(argv):
    parser = argparse.ArgumentParser(description="定位一首歌的副歌起点，输出固定形状的 JSON")
    parser.add_argument("--input", required=True, help="输入音频（wav 优先，mp3/m4a 也可）")
    parser.add_argument("--out", required=True, help="输出 JSON 路径")
    parser.add_argument("--seconds", type=float, default=25.0,
                        help="期望的副歌长度（秒）；--start-at 模式下它是语音条的目标长度，"
                             "并参与句尾视界伸缩 min(max(90, seconds+30), 240)")
    parser.add_argument("--diag", action="store_true", help="把中间诊断也写进 JSON 的 _diag 字段")
    # 仅用于排查：关掉对齐就能看到"对齐前"的原始起点（诊断里两边都记着）。
    parser.add_argument("--no-align", action="store_true", help="关闭人声起点对齐（排查用）")
    parser.add_argument("--start-at", type=float, default=None,
                        help="起点由调用方给定（秒）：跳过副歌搜索与人声对齐，只算这个点之后的句尾。"
                             "不传 = 原来的行为（见文件头）")
    parser.add_argument("--need", type=float, default=None,
                        help="这条语音条**最多**要多长（秒）：只影响句尾视界 horizon_for(need)，"
                             "**不**参与副歌段长与重复段落检测。不传 = 用 --seconds 的值"
                             "（副歌模式下那就等于段长 25，视界停在 90 s 基线）")
    args = parser.parse_args(argv)

    try:
        result, diagnostics = locate(args.input, args.seconds, align=not args.no_align,
                                    start_at=args.start_at, need=args.need)
    except Exception as error:  # 读不了、解码失败、依赖缺失：一律按"定位不可靠"回报
        # 有些异常（librosa 的 NoBackendError）`str(error)` 是空串，只留类型名会让
        # "为什么不可靠"这句话完全没有信息量——所以补一句人能看懂的猜测。
        detail = str(error).strip() or "音频解码失败（文件损坏或缺少解码后端）"
        result = {"ok": False, "reason": f"{type(error).__name__}: {detail}"}
        diagnostics = {}
    if args.diag and diagnostics != {}:
        result["_diag"] = diagnostics

    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False)
        handle.write("\n")
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
