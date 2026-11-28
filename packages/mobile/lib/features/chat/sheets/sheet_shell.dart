import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme.dart';

/// 底部抽屉外壳（原型 `.sheet`）：24px 顶圆角、玻璃渐变、居中抓手。
///
/// 所有通讯台明细（轮次 / 星核 / 模型 / ctx / tok）共用这一份，保证一层
/// 抽屉里再怎么换页，手感与层级都不变（遮罩 58% 黑，Esc / 点遮罩收起）。
Future<T?> showOctoSheet<T>(
  BuildContext context, {
  required String title,
  required String num,
  String? trailing,
  required WidgetBuilder builder,
  double maxHeightFactor = .86,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: const Color(0x9404030A),
    builder: (ctx) {
      final height = MediaQuery.sizeOf(ctx).height;
      return Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(ctx).bottom),
        child: Container(
          constraints: BoxConstraints(maxHeight: height * maxHeightFactor),
          decoration: const BoxDecoration(
            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
            border: Border(
              top: BorderSide(color: Octo.hairline),
              left: BorderSide(color: Octo.hairline),
              right: BorderSide(color: Octo.hairline),
            ),
            gradient: LinearGradient(
              begin: Alignment.topCenter,
              end: Alignment.bottomCenter,
              colors: [Color(0xFC151132), Color(0xFD0A0818)],
            ),
            boxShadow: [
              BoxShadow(
                color: Color(0x99000000),
                blurRadius: 54,
                offset: Offset(0, -20),
              ),
            ],
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.only(top: 9, bottom: 10),
                child: SheetGrab(),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                child: SheetHeader(title: title, num: num, trailing: trailing),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: EdgeInsets.fromLTRB(
                    14,
                    0,
                    14,
                    16 + MediaQuery.viewPaddingOf(ctx).bottom,
                  ),
                  child: builder(ctx),
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class SheetGrab extends StatelessWidget {
  const SheetGrab({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 38,
      height: 4,
      decoration: BoxDecoration(
        color: Octo.metal.withValues(alpha: .32),
        borderRadius: BorderRadius.circular(3),
      ),
    );
  }
}

class SheetHeader extends StatelessWidget {
  const SheetHeader({
    super.key,
    required this.title,
    required this.num,
    this.trailing,
  });

  final String title;
  final String num;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w700,
            color: Colors.white,
          ),
        ),
        const SizedBox(width: 8),
        Text(
          num,
          style: const TextStyle(
            fontFamily: Octo.mono,
            fontSize: 8.5,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.4,
            color: Octo.teal,
          ),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              trailing!,
              textAlign: TextAlign.right,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 9.5,
                height: 1.2,
                color: Octo.dim,
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// 小标题（原型 `.ssec`）：`▸ 当前身份自带 · 只读`。
class SheetSec extends StatelessWidget {
  const SheetSec(this.label, {super.key, this.trailing});

  final String label;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 9, 2, 6),
      child: Row(
        children: [
          Text(
            label,
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 8.5,
              fontWeight: FontWeight.w800,
              letterSpacing: 1.4,
              color: Octo.teal.withValues(alpha: .8),
            ),
          ),
          if (trailing != null) ...[
            const Spacer(),
            Text(
              trailing!,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 9,
                color: Octo.faint,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// 抽屉行（原型 `.srow`）：图标方块 + 标题/副标题 + 右侧尾巴。
class SheetRow extends StatelessWidget {
  const SheetRow({
    super.key,
    required this.title,
    this.icon = '⌘',
    this.description,
    this.trailing,
    this.onTap,
    this.selected = false,
    this.locked = false,
    this.danger = false,
    this.iconColor,
  });

  final String title;
  final String icon;
  final String? description;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool selected;
  final bool locked;
  final bool danger;
  final Color? iconColor;

  @override
  Widget build(BuildContext context) {
    final tone = danger
        ? Octo.red
        : locked
        ? Octo.purple
        : Octo.teal;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(13),
        child: InkWell(
          borderRadius: BorderRadius.circular(13),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(13),
              border: Border.all(
                color: selected
                    ? Octo.teal.withValues(alpha: .4)
                    : Octo.hairlineSoft,
              ),
              color: selected
                  ? Octo.teal.withValues(alpha: .06)
                  : Colors.white.withValues(alpha: .03),
            ),
            child: Row(
              children: [
                Container(
                  width: 26,
                  height: 26,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(
                      color: (iconColor ?? tone).withValues(alpha: .3),
                    ),
                    color: (iconColor ?? tone).withValues(alpha: .08),
                  ),
                  child: Text(
                    icon,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1,
                      color: iconColor ?? tone,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 12.5,
                          height: 1.35,
                          fontWeight: FontWeight.w600,
                          color: Colors.white,
                        ),
                      ),
                      if (description != null && description!.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          description!,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 9.5,
                            height: 1.55,
                            color: Octo.dim,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (trailing != null) ...[const SizedBox(width: 8), trailing!],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 检查圈（原型 `.ck`）—— 选中 = 青底对勾。
class SheetCheck extends StatelessWidget {
  const SheetCheck({super.key, required this.checked});

  final bool checked;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 19,
      height: 19,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: checked ? Octo.teal : Colors.transparent,
        border: Border.all(
          color: checked ? Octo.teal : Octo.metal.withValues(alpha: .3),
        ),
      ),
      child: checked
          ? const Text(
              '✓',
              style: TextStyle(
                fontSize: 11,
                height: 1,
                fontWeight: FontWeight.w800,
                color: Color(0xFF06131A),
              ),
            )
          : null,
    );
  }
}

/// 抽屉里的小药丸按钮（`.btn` / `.btn.ghost` / `.btn.red`）。
class SheetPill extends StatelessWidget {
  const SheetPill({
    super.key,
    required this.label,
    this.onTap,
    this.tone = SheetPillTone.teal,
  });

  final String label;
  final VoidCallback? onTap;
  final SheetPillTone tone;

  @override
  Widget build(BuildContext context) {
    final (fg, bg, border) = switch (tone) {
      SheetPillTone.teal => (
        Octo.teal,
        Octo.teal.withValues(alpha: .10),
        Octo.teal.withValues(alpha: .40),
      ),
      SheetPillTone.ghost => (Octo.metal, Colors.transparent, Octo.hairline),
      SheetPillTone.red => (
        Octo.red,
        Octo.red.withValues(alpha: .10),
        Octo.red.withValues(alpha: .40),
      ),
      SheetPillTone.purple => (
        Octo.purple,
        Octo.violet.withValues(alpha: .16),
        Octo.purple.withValues(alpha: .40),
      ),
    };
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: border),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 9.5,
              height: 1,
              fontWeight: FontWeight.w700,
              letterSpacing: .3,
              color: fg,
            ),
          ),
        ),
      ),
    );
  }
}

enum SheetPillTone { teal, ghost, red, purple }

/// 键值行（原型 `.kv`）：左标签右数字，数字走等宽。
class SheetKv extends StatelessWidget {
  const SheetKv({
    super.key,
    required this.label,
    required this.value,
    this.tone,
  });

  final String label;
  final String value;
  final Color? tone;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4.5),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.5,
                color: Octo.dim,
              ),
            ),
          ),
          Text(
            value,
            style: TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10.5,
              height: 1.5,
              fontWeight: FontWeight.w600,
              color: tone ?? Octo.ink,
            ),
          ),
        ],
      ),
    );
  }
}

/// 抽屉脚注（原型 `.sfoot`）：灰字，解释口径 / 边界。
class SheetFoot extends StatelessWidget {
  const SheetFoot(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(2, 8, 2, 2),
      child: Text(
        text,
        style: const TextStyle(
          fontFamily: Octo.mono,
          fontSize: 9.5,
          height: 1.6,
          color: Octo.faint,
        ),
      ),
    );
  }
}

/// 搜索框（星核 · 技能）。
class SheetSearch extends StatelessWidget {
  const SheetSearch({
    super.key,
    required this.controller,
    required this.hint,
    this.onChanged,
  });

  final TextEditingController controller;
  final String hint;
  final ValueChanged<String>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 9),
      padding: const EdgeInsets.symmetric(horizontal: 11),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Octo.hairline),
        color: const Color(0x9E100D28),
      ),
      child: Row(
        children: [
          const Text('⌕', style: TextStyle(fontSize: 12, color: Octo.teal)),
          const SizedBox(width: 7),
          Expanded(
            child: TextField(
              controller: controller,
              onChanged: onChanged,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 11,
                color: Octo.ink,
              ),
              decoration: InputDecoration(
                hintText: hint,
                isDense: true,
                filled: false,
                border: InputBorder.none,
                enabledBorder: InputBorder.none,
                focusedBorder: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(vertical: 11),
                hintStyle: const TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 11,
                  color: Octo.dim,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 分段选择（原型 `.stabs` / `.sseg`）。
class SheetTabs extends StatelessWidget {
  const SheetTabs({
    super.key,
    required this.tabs,
    required this.index,
    required this.onChanged,
    this.compact = false,
  });

  final List<String> tabs;
  final int index;
  final ValueChanged<int> onChanged;

  /// true = 小号分段（思考强度 / 上下文窗口），false = 星核四栏。
  final bool compact;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Octo.hairlineSoft),
        color: const Color(0xB30A0818),
      ),
      child: Row(
        children: [
          for (var i = 0; i < tabs.length; i++)
            Expanded(
              child: Material(
                color: Colors.transparent,
                child: InkWell(
                  borderRadius: BorderRadius.circular(999),
                  onTap: () => onChanged(i),
                  child: Container(
                    padding: EdgeInsets.symmetric(vertical: compact ? 7 : 8),
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(999),
                      gradient: i == index ? Octo.accentGradient : null,
                    ),
                    child: Text(
                      tabs[i],
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: compact ? 11 : 11.5,
                        height: 1,
                        fontWeight: i == index
                            ? FontWeight.w700
                            : FontWeight.w600,
                        color: i == index ? const Color(0xFF06131A) : Octo.dim,
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// 水平进度条（ctx 明细页顶）。
class SheetBar extends StatelessWidget {
  const SheetBar({super.key, required this.value, this.tone = Octo.teal});

  /// 0–1。
  final double value;
  final Color tone;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 6,
      margin: const EdgeInsets.only(top: 2, bottom: 6),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Octo.hairline.withValues(alpha: .5),
        borderRadius: BorderRadius.circular(3),
      ),
      child: Align(
        alignment: Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: value.clamp(0, 1).toDouble(),
          heightFactor: 1,
          child: ColoredBox(color: tone),
        ),
      ),
    );
  }
}

/// 把长文本塞进剪贴板（导出 / 复制）。
Future<void> copyToClipboard(String text) async {
  await Clipboard.setData(ClipboardData(text: text));
}
