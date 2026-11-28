/// 流尾工作行的状态词 —— 桌面 `web-app/lib/agent/work-phrases.ts` 的手机端移植。
///
/// 规则与桌面逐条一致（2026-11-03 用户）：
///   · 按阶段分组（阶段语义仍可辨），每 [kWorkPhraseRotateSeconds] 秒换一句；
///   · 数组按「普通句、修仙句、修仙句」三句一组交错排列；
///   · 每轮用回合起点做种子的 Fisher-Yates 洗牌：同 seed 顺序稳定，
///     换一轮就换一个开头；不逐秒随机，避免闪烁；
///   · 每句都很短（≤12 字），右侧紧跟计时。
///
/// 文案表是复制过来的常量，不跨包共享：手机包不依赖 web-app 的构建产物，
/// 桌面改了这里要跟着改（见 `docs/cabin-design/design/35-mobile-dev-plan.md`）。
library;

enum WorkPhase { thinking, exec, writing }

/// 每 6 秒轮换一句：够慢到读得完，够快到不无聊。
const kWorkPhraseRotateSeconds = 6;

/// 转字：与桌面 `TUI_SPIN` 同一组盲文点阵。
const kWorkSpin = <String>['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const kWorkPhrases = <WorkPhase, List<String>>{
  WorkPhase.thinking: [
    // 普通 · 修仙 · 修仙 交错
    '脑内推演中…',
    '掐指一算，掐空了…',
    '元神出窍查资料…',
    '正在跟需求对视…',
    '灵台推演天机…',
    '入定，勿扰…',
    '琢磨着呢…',
    '神识扫描中…',
    '内视周天中…',
    '挠头中…',
    '打坐参悟需求…',
    '翻开无字天书…',
    '让想象力跑一会儿…',
    '向祖师爷借个思路…',
    '灵气不足，硬想…',
    '这题有点意思…',
    '渡劫般梳理逻辑…',
    '和心魔辩论中…',
  ],
  WorkPhase.exec: [
    '动手了…',
    '催动法器…',
    '开炉炼器…',
    '正在敲敲打打…',
    '引雷淬体…',
    '搬运灵气中…',
    '跟终端商量中…',
    '施展袖里乾坤…',
    '给天道打个补丁…',
    '正在翻箱倒柜…',
    '御剑去改文件…',
    '炼丹炉火正旺…',
    '和文件较劲中…',
    '布阵中，别踩线…',
    '和法宝谈条件…',
    '真没摸鱼，在干活…',
    '渡劫式跑测试…',
    '搬砖，哦不，搬山…',
  ],
  WorkPhase.writing: [
    '落笔中…',
    '以文入道…',
    '刻录玉简…',
    '码字中…',
    '笔下生莲…',
    '心法吐真言…',
    '正在组织语言…',
    '灵气化墨…',
    '大道至简，先写…',
    '把想法翻译成人话…',
    '写篇大道真解…',
    '落笔惊动雷劫…',
    '键盘都要冒烟了…',
    '正在凝聚道韵…',
    '字字带修为…',
    '别催，在写了…',
    '写不好就重修…',
    '给答案开个光…',
  ],
};

/// 32 位乘法（对齐 JS `Math.imul`；Dart 的 int 是 64 位，直接乘会溢出）。
int _mul32(int a, int b) {
  final aLo = a & 0xFFFF;
  final aHi = (a >> 16) & 0xFFFF;
  return (aLo * b + (((aHi * b) & 0xFFFF) << 16)) & 0xFFFFFFFF;
}

/// mulberry32：32 位种子 PRNG —— 同 seed 同结果，换轮换序。
double Function() _mulberry32(int seed) {
  var a = seed & 0xFFFFFFFF;
  return () {
    a = (a + 0x6D2B79F5) & 0xFFFFFFFF;
    var t = a;
    t = _mul32(t ^ (t >> 15), t | 1);
    t = (t ^ (t + _mul32(t ^ (t >> 7), t | 61))) & 0xFFFFFFFF;
    return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0;
  };
}

/// 按 seed 洗出该阶段的展示顺序；seed 为 0 时保持原数组顺序。
List<String> orderedWorkPhrases(WorkPhase phase, int seed) {
  final list = kWorkPhrases[phase]!;
  if (seed == 0) return list;
  final out = List<String>.of(list);
  final rand = _mulberry32(seed);
  for (var i = out.length - 1; i > 0; i--) {
    final j = (rand() * (i + 1)).floor().clamp(0, i);
    final tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/// 当前该显示哪一句（[elapsedSeconds] = 整轮已耗时，取整秒）。
String workPhrase(WorkPhase phase, int elapsedSeconds, {int seed = 0}) {
  final list = orderedWorkPhrases(phase, seed);
  final bucket = elapsedSeconds < 0
      ? 0
      : elapsedSeconds ~/ kWorkPhraseRotateSeconds;
  return list[bucket % list.length];
}

/// 转字帧：桌面按 `elapsed*10 % 10` 走（每 100ms 一帧）。
String workSpinGlyph(double elapsedSeconds) {
  final n = (elapsedSeconds * 10).floor();
  return kWorkSpin[n.abs() % kWorkSpin.length];
}

/// 计时：`0:12` / `12:34` / `1:02:03`（与原型 / 桌面同口径，不补零到两位）。
String formatWorkElapsed(int seconds) {
  final s = seconds < 0 ? 0 : seconds;
  final h = s ~/ 3600;
  final m = (s % 3600) ~/ 60;
  final sec = s % 60;
  final two = sec.toString().padLeft(2, '0');
  if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$two';
  return '$m:$two';
}
