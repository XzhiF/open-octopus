import 'package:flutter/material.dart';

import '../../app/theme.dart';
import '../../core/models/telemetry.dart';

/// 顶栏副标题里的身份胶囊（原型 §4 E14）：
/// `((汐音小像)) 舱调度者 ▾` —— 点开仍是星核 · 分身。
///
/// 它从输入区上方挪上来，免得「◉ 舱调度者」孤零零占一行；
/// 主 Agent 没有 clone 立绘，用一个紫点代替小像。
class RoleBarChip extends StatelessWidget {
  const RoleBarChip({super.key, required this.role, this.onTap});

  final SessionRole role;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final main = role.isMain;
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(999),
        onTap: onTap,
        child: Container(
          height: 24,
          padding: EdgeInsets.only(left: main ? 8 : 4, right: 7),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(999),
            border: Border.all(color: Octo.purple.withValues(alpha: .44)),
            color: Octo.violet.withValues(alpha: .16),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (main)
                Container(
                  width: 4,
                  height: 4,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: Octo.purple,
                    boxShadow: [BoxShadow(color: Octo.purple, blurRadius: 6)],
                  ),
                )
              else ...[
                ClipOval(
                  child: Container(
                    width: 17,
                    height: 17,
                    color: const Color(0xFF151034),
                    child: Image.asset(
                      'assets/crew/xiyin-idle.png',
                      fit: BoxFit.cover,
                      alignment: const Alignment(0, -.96),
                      errorBuilder: (_, _, _) => const Icon(
                        Icons.person_outline,
                        size: 11,
                        color: Octo.purple,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 4),
              ],
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 130),
                child: Text(
                  role.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 8.5,
                    height: 1,
                    fontWeight: FontWeight.w800,
                    letterSpacing: .3,
                    color: Octo.purple,
                  ),
                ),
              ),
              const Padding(
                padding: EdgeInsets.only(left: 4),
                child: Text(
                  '▾',
                  style: TextStyle(fontSize: 7, height: 1, color: Octo.purple),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 输入区上方的一次性贴纸：只挂技能 / 委派时才冒出来（身份已经上移顶栏）。
/// 两样都没有时返回空 —— 输入区就是干干净净一条输入行。
class ChatAttachmentChips extends StatelessWidget {
  const ChatAttachmentChips({
    super.key,
    this.skill,
    this.subagent,
    this.onSkillClear,
    this.onSubagentClear,
  });

  final String? skill;
  final ChatSubagentRef? subagent;
  final VoidCallback? onSkillClear;
  final VoidCallback? onSubagentClear;

  @override
  Widget build(BuildContext context) {
    if (skill == null && subagent == null) return const SizedBox.shrink();
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        children: [
          if (subagent != null)
            _Pill(
              icon: '⇢',
              label: '委派 ${subagent!.label}',
              fg: Octo.amber,
              border: Octo.amber.withValues(alpha: .4),
              bg: Octo.amber.withValues(alpha: .1),
              onClear: onSubagentClear,
            ),
          if (subagent != null && skill != null) const SizedBox(width: 6),
          if (skill != null)
            _Pill(
              icon: '⌘',
              label: '/$skill',
              fg: Octo.teal,
              border: Octo.teal.withValues(alpha: .38),
              bg: Octo.teal.withValues(alpha: .08),
              onClear: onSkillClear,
            ),
        ],
      ),
    );
  }
}

class _Pill extends StatelessWidget {
  const _Pill({
    required this.icon,
    required this.label,
    required this.fg,
    required this.border,
    required this.bg,
    this.onClear,
  });

  final String icon;
  final String label;
  final Color fg;
  final Color border;
  final Color bg;
  final VoidCallback? onClear;

  @override
  Widget build(BuildContext context) {
    return Container(
      height: 26,
      padding: EdgeInsets.only(left: 9, right: onClear == null ? 10 : 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(icon, style: TextStyle(fontSize: 10, height: 1, color: fg)),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 150),
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                height: 1,
                fontWeight: FontWeight.w700,
                letterSpacing: .2,
                color: fg,
              ),
            ),
          ),
          if (onClear != null)
            GestureDetector(
              onTap: onClear,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: const EdgeInsets.only(
                  left: 5,
                  top: 7,
                  bottom: 7,
                  right: 4,
                ),
                child: Text(
                  '✕',
                  style: TextStyle(
                    fontSize: 9,
                    height: 1,
                    color: fg.withValues(alpha: .8),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}
