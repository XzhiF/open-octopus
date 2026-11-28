import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/models/quote.dart';
import '../../core/models/telemetry.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';
import 'chat_pane.dart';
import 'identity_chip.dart';

/// F / G · 会话：桌面 TUI 语法原样，发消息走 POST 内联 SSE，逐帧追加。
/// 从「待你定」点进来时带一条引用上下文（G），回复仍然是正常消息。
class SessionScreen extends ConsumerStatefulWidget {
  const SessionScreen({
    super.key,
    required this.workspaceId,
    required this.sessionId,
    this.quote,
    this.agent = false,
  });

  final String? workspaceId;
  final String sessionId;
  final SessionQuote? quote;

  /// 舱会话（agent session）走 /api/agent；单独会话走旧的 chat/sessions。
  final bool agent;

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen> {
  final GlobalKey<ChatPaneState> _paneKey = GlobalKey<ChatPaneState>();
  SessionQuote? _quote;
  String? _title;

  /// agent 会话的身份（原型 E14：顶栏胶囊，点开星核 · 分身）。
  SessionRole? _role;

  @override
  void initState() {
    super.initState();
    _quote = widget.quote;
  }

  void _onRoleChanged(SessionRole? role) {
    if (identical(role, _role)) return;
    if (role?.revision == _role?.revision && role?.label == _role?.label) {
      return;
    }
    setState(() => _role = role);
  }

  /// 顶栏副标题：`(汐音小像) 舱调度者 ▾  书房 PC · 舱会话`（原型 E14）。
  Widget _barSubtitle(String? deviceName, String? stageLabel) {
    final role = _role;
    if (role == null) return const SizedBox.shrink();
    final text = [
      deviceName,
      stageLabel ?? (widget.workspaceId == null ? '不归属任何舱' : '舱会话'),
    ].whereType<String>().join(' · ');
    return Row(
      children: [
        RoleBarChip(
          role: role,
          onTap: () => _paneKey.currentState?.openRoleSheet(),
        ),
        if (text.isNotEmpty) ...[
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                letterSpacing: .4,
                color: Octo.dim,
              ),
            ),
          ),
        ],
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final device = ref.watch(currentDeviceProvider);
    final quote = _quote;

    return Scaffold(
      backgroundColor: Octo.screen,
      resizeToAvoidBottomInset: true,
      body: SceneBackground(
        asset: SceneBackground.deepspace,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                // 引用态按原型 G 屏：标题「回复 QUOTE」，副标题是设备 · 那一档状态。
                title: quote != null ? '回复' : (_title ?? '会话'),
                num: quote != null ? 'QUOTE' : 'CHAT',
                subtitle: [
                  device?.name,
                  quote != null
                      ? quote.stage.label
                      : (widget.workspaceId == null ? '不归属任何舱' : '舱会话'),
                ].whereType<String>().join(' · '),
                subtitleWidget: widget.agent && _role != null
                    ? _barSubtitle(device?.name, quote?.stage.label)
                    : null,
                onBack: () => context.pop(),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                actions: [
                  BarIconButton(
                    onTap: () => _paneKey.currentState?.reload(),
                    child: const Icon(
                      Icons.refresh,
                      size: 16,
                      color: Octo.metal2,
                    ),
                  ),
                ],
              ),
              Expanded(
                child: ChatPane(
                  key: _paneKey,
                  workspaceId: widget.workspaceId,
                  sessionId: widget.sessionId,
                  agent: widget.agent,
                  quote: quote,
                  onQuoteClosed: () => setState(() => _quote = null),
                  onRoleChanged: _onRoleChanged,
                  onSessionLoaded: (session) {
                    final title = session?.displayTitle;
                    if (title != null && title != _title) {
                      setState(() => _title = title);
                    }
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
