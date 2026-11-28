import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/format.dart';
import '../../../core/http.dart';
import '../../../core/models/telemetry.dart';
import '../../chat/chat_controller.dart';
import 'sheet_shell.dart';

/// 星核（原型 E4–E6）：技能 / 分身 / MCP / 会话四栏。
///
/// 「技能」挂载走 `/skill-name 你的话`，「分身」切换写会话 role，委派是一次性
/// subagent；「会话」里的压缩 / 清空 / 改名 / 导出都走真实服务端动作。
Future<void> showCoreSheet(
  BuildContext context, {
  required ChatController chat,
  required String? attachedSkill,
  required ChatSubagentRef? attachedSubagent,
  required ValueChanged<String?> onSkillChanged,
  required ValueChanged<ChatSubagentRef?> onSubagentChanged,
  required Future<void> Function() onCompact,
  required Future<void> Function() onClear,
  required Future<void> Function() onAutocompact,
  required Future<void> Function(String title) onRename,
  required Future<void> Function() onExport,
  int initialTab = 0,
}) {
  return showOctoSheet<void>(
    context,
    title: '星核',
    num: 'CORE',
    trailing: '✦ 技能 · 分身 · MCP · 会话',
    maxHeightFactor: .86,
    builder: (ctx) => _CoreSheetBody(
      chat: chat,
      attachedSkill: attachedSkill,
      attachedSubagent: attachedSubagent,
      onSkillChanged: onSkillChanged,
      onSubagentChanged: onSubagentChanged,
      onCompact: onCompact,
      onClear: onClear,
      onAutocompact: onAutocompact,
      onRename: onRename,
      onExport: onExport,
      initialTab: initialTab,
    ),
  );
}

class _CoreSheetBody extends StatefulWidget {
  const _CoreSheetBody({
    required this.chat,
    required this.attachedSkill,
    required this.attachedSubagent,
    required this.onSkillChanged,
    required this.onSubagentChanged,
    required this.onCompact,
    required this.onClear,
    required this.onAutocompact,
    required this.onRename,
    required this.onExport,
    required this.initialTab,
  });

  final ChatController chat;
  final String? attachedSkill;
  final ChatSubagentRef? attachedSubagent;
  final ValueChanged<String?> onSkillChanged;
  final ValueChanged<ChatSubagentRef?> onSubagentChanged;
  final Future<void> Function() onCompact;
  final Future<void> Function() onClear;
  final Future<void> Function() onAutocompact;
  final Future<void> Function(String title) onRename;
  final Future<void> Function() onExport;
  final int initialTab;

  @override
  State<_CoreSheetBody> createState() => _CoreSheetBodyState();
}

class _CoreSheetBodyState extends State<_CoreSheetBody> {
  late int _tab = widget.initialTab;
  late SessionRole _role = widget.chat.role ?? const SessionRole();
  late String? _skill = widget.attachedSkill;
  late ChatSubagentRef? _subagent = widget.attachedSubagent;

  List<SkillInfo>? _skills;
  List<CloneRef>? _clones;
  List<McpServerInfo>? _mcp;
  Object? _error;
  final TextEditingController _search = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
    // 进抽屉再校准一次身份：冷启动时 role 可能因一次网络抖动没读到，
    // 界面上会误显示「主 Agent」。这里静默重拉，读到就覆盖。
    _refreshRole();
  }

  Future<void> _refreshRole() async {
    try {
      final next = await widget.chat.api.sessionRole(widget.chat.sessionId);
      if (!mounted) return;
      setState(() => _role = next);
    } catch (_) {
      // 拉不到就沿用打开时的快照（主 Agent 只是显示兜底）。
    }
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait<Object>([
        widget.chat.api.skills(),
        widget.chat.api.clones(),
        widget.chat.api.mcpServers(),
      ]);
      if (!mounted) return;
      setState(() {
        _skills = results[0] as List<SkillInfo>;
        _clones = results[1] as List<CloneRef>;
        _mcp = results[2] as List<McpServerInfo>;
        _error = null;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        SheetTabs(
          tabs: const ['技能', '分身', 'MCP', '会话'],
          index: _tab,
          onChanged: (index) => setState(() => _tab = index),
        ),
        if (_error != null)
          SheetRow(
            icon: '!',
            title: '星核没读出来',
            description: '${_error!}',
            danger: true,
            trailing: SheetPill(label: '重试', onTap: _load),
          )
        else if (_skills == null || _clones == null || _mcp == null)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 28),
            child: Center(
              child: Text(
                '正在读星核…',
                style: TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 10.5,
                  color: Octo.dim,
                ),
              ),
            ),
          )
        else
          switch (_tab) {
            0 => _skillsTab(),
            1 => _clonesTab(),
            2 => _mcpTab(),
            _ => _sessionTab(),
          },
      ],
    );
  }

  // ── 技能 ──────────────────────────────────────────────────────────

  Widget _skillsTab() {
    final identity = _role.skills.toSet();
    final query = _search.text.trim().toLowerCase();
    final all = _skills ?? const <SkillInfo>[];
    final rest = all
        .where((s) => !identity.contains(s.name))
        .where((s) => query.isEmpty || s.name.toLowerCase().contains(query))
        .toList(growable: false);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        SheetSearch(
          controller: _search,
          hint: '搜技能名，如 octo-wiki',
          onChanged: (_) => setState(() {}),
        ),
        if (identity.isNotEmpty) ...[
          const SheetSec('当前身份自带 · 只读'),
          for (final name in identity)
            SheetRow(
              icon: '✦',
              title: name,
              description: '随「${_role.label}」生效 · 不能摘',
              locked: true,
              trailing: const Text(
                '🔒',
                style: TextStyle(fontSize: 10, color: Octo.purple),
              ),
            ),
        ],
        const SheetSec('全部技能'),
        for (final skill in rest)
          SheetRow(
            icon: skill.source == 'local_evolved' ? '✎' : '⌘',
            title: skill.name,
            description: skill.sourceLabel,
            selected: _skill == skill.name,
            onTap: () {
              final next = _skill == skill.name ? null : skill.name;
              setState(() => _skill = next);
              widget.onSkillChanged(next);
            },
            trailing: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '${formatTokNum(skill.tokenCount)} tok',
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9.5,
                    color: Octo.dim,
                  ),
                ),
                const SizedBox(width: 8),
                SheetCheck(checked: _skill == skill.name),
              ],
            ),
          ),
        const SheetFoot('选中 = 挂到下一条消息（发送后自动摘掉）。技能 ↔ 会话操作分成两栏，见「会话」。'),
      ],
    );
  }

  // ── 分身 ──────────────────────────────────────────────────────────

  Widget _clonesTab() {
    final clones = _clones ?? const <CloneRef>[];
    final current = _role.clone;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const SheetSec('当前身份'),
        SheetRow(
          icon: '◉',
          title: _role.label,
          description: _role.isMain
              ? '基础身份 · 平台默认'
              : '${current?.name ?? _role.activeExpert} · 下一条消息生效',
          selected: true,
          iconColor: Octo.purple,
          trailing: Text(
            _role.isMain ? '当前' : '当前 · 可切回',
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 9.5,
              color: Octo.purple,
            ),
          ),
          onTap: null,
        ),
        if (!_role.isMain)
          SheetRow(
            icon: '○',
            title: '主 Agent',
            description: '基础身份 · 平台默认',
            onTap: () => _switchRole(null),
            trailing: SheetPill(
              label: '切回',
              tone: SheetPillTone.ghost,
              onTap: () => _switchRole(null),
            ),
          ),
        const SheetSec('切换身份 · 下一条消息生效'),
        for (final clone in clones)
          if (clone.name != _role.activeExpert)
            SheetRow(
              icon: '◉',
              title: clone.displayName,
              description: [
                clone.name,
                if (clone.skills.isNotEmpty) '技能 ${clone.skills.length}',
                clone.memoryScope == 'shared' ? '共享记忆' : '独立记忆',
              ].join(' · '),
              onTap: () => _switchRole(clone.name),
              trailing: SheetPill(
                label: '切换',
                tone: SheetPillTone.ghost,
                onTap: () => _switchRole(clone.name),
              ),
            ),
        const SheetSec('委派 · 一次性，随下一条消息消费'),
        for (final clone in clones)
          SheetRow(
            icon: '⚙',
            title: clone.displayName,
            description: clone.persona.trim().isEmpty
                ? clone.name
                : clone.persona.replaceAll(RegExp(r'\s+'), ' ').trim(),
            selected: _subagent?.id == clone.name,
            onTap: () {
              final next = _subagent?.id == clone.name
                  ? null
                  : ChatSubagentRef(id: clone.name, label: clone.displayName);
              setState(() => _subagent = next);
              widget.onSubagentChanged(next);
            },
            trailing: SheetPill(
              label: _subagent?.id == clone.name ? '已选' : '委派',
              tone: _subagent?.id == clone.name
                  ? SheetPillTone.teal
                  : SheetPillTone.ghost,
              onTap: () {
                final next = _subagent?.id == clone.name
                    ? null
                    : ChatSubagentRef(id: clone.name, label: clone.displayName);
                setState(() => _subagent = next);
                widget.onSubagentChanged(next);
              },
            ),
          ),
        const SheetFoot('身份切换不改历史；输入区上方的身份贴纸点 ✕ 也能直接回主身份。委派只作用于下一条消息。'),
      ],
    );
  }

  Future<void> _switchRole(String? expert) async {
    try {
      final next = await widget.chat.setRole(expert);
      if (!mounted) return;
      setState(() => _role = next);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(describeError(e)),
          backgroundColor: Octo.red.withValues(alpha: .9),
        ),
      );
    }
  }

  // ── MCP ───────────────────────────────────────────────────────────

  Widget _mcpTab() {
    final servers = _mcp ?? const <McpServerInfo>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const SheetSec('内置 MCP · 按会话挂载'),
        for (final server in servers)
          SheetRow(
            icon: '⚙',
            title: server.label,
            description:
                '${server.server} · ${server.toolNames.length} 个工具 · ${server.when}',
            trailing: const Text(
              '只读',
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 9.5,
                color: Octo.faint,
              ),
            ),
          ),
        const SheetFoot('MCP 由会话类型决定（任务线程 / 舱 / 工作空间各挂各的），手机端只读；要关就回桌面改会话配置。'),
      ],
    );
  }

  // ── 会话 ──────────────────────────────────────────────────────────

  Widget _sessionTab() {
    final ctx = widget.chat.contextUsage;
    final title = widget.chat.session?.displayTitle ?? '新会话';
    final ctxLabel = ctx == null
        ? '当前占用 --'
        : '${formatTokNum(ctx.totalTokens)} / ${formatTokNum(ctx.maxTokens)}';
    // 跑动中不让压 / 清 —— 这两件事都要等这一轮收口。
    final busy = widget.chat.sending;
    final busyNote = busy ? ' · 跑动中不可用' : '';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        const SheetSec('上下文'),
        SheetRow(
          icon: '⚡',
          title: '压缩上下文',
          description: '$ctxLabel → 摘要（/compact）$busyNote',
          onTap: busy ? null : () => _runCommand(widget.onCompact),
          trailing: SheetPill(
            label: '压缩',
            onTap: busy ? null : () => _runCommand(widget.onCompact),
          ),
        ),
        SheetRow(
          icon: '⌫',
          title: '清空上下文',
          description: '清掉 SDK 上下文，聊天记录保留（/clear）$busyNote',
          danger: true,
          onTap: busy ? null : _confirmClear,
          trailing: SheetPill(
            label: '清空',
            tone: SheetPillTone.red,
            onTap: busy ? null : _confirmClear,
          ),
        ),
        SheetRow(
          icon: '↻',
          title: '自动压缩',
          description: '到 85% 自动压（/autocompact）$busyNote',
          onTap: busy ? null : () => _runCommand(widget.onAutocompact),
          trailing: SheetPill(
            label: '调整',
            tone: SheetPillTone.ghost,
            onTap: busy ? null : () => _runCommand(widget.onAutocompact),
          ),
        ),
        const SheetSec('会话'),
        SheetRow(
          icon: '✎',
          title: '重命名会话',
          description: '现在叫「$title」（/rename）',
          trailing: SheetPill(
            label: '改名',
            tone: SheetPillTone.ghost,
            onTap: () => _rename(title),
          ),
        ),
        SheetRow(
          icon: '⇥',
          title: '导出最近 20 轮',
          description: '纯文本，复制到剪贴板（只读，不改会话）',
          trailing: SheetPill(
            label: '导出',
            tone: SheetPillTone.ghost,
            onTap: () async {
              Navigator.of(context).pop();
              await widget.onExport();
            },
          ),
        ),
        const SheetFoot(
          '这些是「对这次会话动手」的开关 —— 与技能 / 分身 / MCP 分清；清空要二次确认，压完在转录里留一条系统行。',
        ),
      ],
    );
  }

  /// 命令类动作：先收起抽屉，再把斜杠命令发进会话流。
  Future<void> _runCommand(Future<void> Function() action) async {
    final navigator = Navigator.of(context);
    if (navigator.canPop()) navigator.pop();
    await action();
  }

  Future<void> _confirmClear() async {
    final ok = await showDialog<bool>(
      context: context,
      barrierColor: const Color(0x9904030A),
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF141026),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Octo.rL),
          side: BorderSide(color: Octo.red.withValues(alpha: .35)),
        ),
        title: const Text(
          '清空上下文？',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w700,
            color: Colors.white,
          ),
        ),
        content: const Text(
          'SDK 上下文会丢（下一条消息从零开始），聊天记录保留。这个动作不可撤销。',
          style: TextStyle(fontSize: 12.5, height: 1.6, color: Octo.ink2),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('取消', style: TextStyle(color: Octo.metal)),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text(
              '清空',
              style: TextStyle(color: Octo.red, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    Navigator.of(context).pop();
    await widget.onClear();
  }

  Future<void> _rename(String current) async {
    final controller = TextEditingController(text: current);
    final title = await showDialog<String>(
      context: context,
      barrierColor: const Color(0x9904030A),
      builder: (ctx) => AlertDialog(
        backgroundColor: const Color(0xFF141026),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(Octo.rL),
          side: const BorderSide(color: Octo.hairline),
        ),
        title: const Text(
          '重命名会话',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w700,
            color: Colors.white,
          ),
        ),
        content: TextField(
          controller: controller,
          autofocus: true,
          style: const TextStyle(
            fontFamily: Octo.mono,
            fontSize: 12,
            color: Octo.ink,
          ),
          decoration: const InputDecoration(hintText: '会话名称'),
          onSubmitted: (value) => Navigator.of(ctx).pop(value.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('取消', style: TextStyle(color: Octo.metal)),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
            child: const Text(
              '保存',
              style: TextStyle(color: Octo.teal, fontWeight: FontWeight.w700),
            ),
          ),
        ],
      ),
    );
    controller.dispose();
    if (title == null || title.isEmpty || !mounted) return;
    await widget.onRename(title);
    if (mounted) Navigator.of(context).pop();
  }
}
