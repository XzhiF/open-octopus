/// 时间 / 数字的人话格式。「上次 5 小时前」「3 天前」这类。
String formatAgo(String? iso, {DateTime? now}) {
  if (iso == null || iso.trim().isEmpty) return '还没连过';
  final t = DateTime.tryParse(iso);
  if (t == null) return iso;
  final n = now ?? DateTime.now();
  final diff = n.difference(t.toLocal());
  if (diff.isNegative) return '刚刚';
  if (diff.inSeconds < 60) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟前';
  if (diff.inHours < 24) return '${diff.inHours} 小时前';
  if (diff.inDays < 30) return '${diff.inDays} 天前';
  if (diff.inDays < 365) return '${(diff.inDays / 30).floor()} 个月前';
  return '${(diff.inDays / 365).floor()} 年前';
}

/// ISO → `MM-DD HH:mm`（本地时区）。
String formatStamp(String? iso) {
  if (iso == null || iso.trim().isEmpty) return '—';
  final t = DateTime.tryParse(iso)?.toLocal();
  if (t == null) return iso;
  String two(int v) => v.toString().padLeft(2, '0');
  return '${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}';
}

/// 12.3k / 1.2M —— 与桌面同一口径。
String formatCount(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(1)}k';
  return '$n';
}

/// 通讯台头的 token 读数：1.2K / 12.3K / 200K / 1M（原型大写 K）。
/// 小数只在需要时保留一位（200.0K → 200K）。
String formatTokNum(int n) {
  String trim(String s) => s.endsWith('.0') ? s.substring(0, s.length - 2) : s;
  if (n >= 1000000) return '${trim((n / 1000000).toStringAsFixed(1))}M';
  if (n >= 1000) return '${trim((n / 1000).toStringAsFixed(1))}K';
  return '$n';
}

/// 轮次抽屉里的相对时间：刚刚 / 2 分钟 / 8 分钟 / 3 小时 / 2 天。
String formatAgoShort(String? iso, {DateTime? now}) {
  if (iso == null || iso.trim().isEmpty) return '—';
  final t = DateTime.tryParse(iso);
  if (t == null) return '—';
  final diff = (now ?? DateTime.now()).difference(t.toLocal());
  if (diff.isNegative || diff.inSeconds < 60) return '刚刚';
  if (diff.inMinutes < 60) return '${diff.inMinutes} 分钟';
  if (diff.inHours < 24) return '${diff.inHours} 小时';
  return '${diff.inDays} 天';
}

/// USD → 人民币展示（桌面 TUI 同口径 ×7）；null = 未定价，显示「—」。
String formatCny(double? usd, {bool complete = true}) {
  if (usd == null) return '—';
  final value = usd * 7;
  final text = '¥${value.toStringAsFixed(2)}';
  return complete ? text : '≈$text';
}

/// 0–1 比率 → `62.4%`；null = 没有输入类 token，显示「—」。
String formatRate(double? rate) {
  if (rate == null) return '—';
  return '${(rate * 100).toStringAsFixed(1)}%';
}

/// 路径缩略：`C:\xzf\ai\open-octopus` → 保留尾部，前面用 … 收掉。
String shortenPath(String path, {int max = 42}) {
  final p = path.trim();
  if (p.length <= max) return p;
  return '…${p.substring(p.length - max + 1)}';
}

/// 尾巴两段：`C:\xzf\ai\open-octopus` → `open-octopus` 的上级 + 自己。
String pathTail(String path) {
  final parts = path
      .split(RegExp(r'[\\/]'))
      .where((s) => s.isNotEmpty)
      .toList();
  if (parts.length <= 2) return path;
  return '…/${parts.sublist(parts.length - 2).join('/')}';
}
