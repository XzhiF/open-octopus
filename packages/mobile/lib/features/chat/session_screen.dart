import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/models/chat.dart';
import '../../core/models/quote.dart';
import '../../core/providers.dart';
import '../../widgets/composer.dart';
import '../../widgets/crew_video.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/quote_bar.dart';
import '../../widgets/scene_background.dart';
import '../../widgets/states.dart';
import '../../widgets/tui.dart';
import 'chat_controller.dart';

/// F / G · 会话：桌面 TUI 语法原样，发消息走 POST 内联 SSE，逐帧追加。
/// 从「待你定」点进来时带一条引用上下文（G），回复仍然是正常消息。
class SessionScreen extends ConsumerStatefulWidget {
  const SessionScreen({
    super.key,
    required this.workspaceId,
    required this.sessionId,
    this.quote,
  });

  final String? workspaceId;
  final String sessionId;
  final SessionQuote? quote;

  @override
  ConsumerState<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends ConsumerState<SessionScreen>
    with WidgetsBindingObserver {
  ChatController? _chat;
  final ScrollController _scroll = ScrollController();
  bool _atBottom = true;
  bool _bootError = false;
  SessionQuote? _quote;

  @override
  void initState() {
    super.initState();
    _quote = widget.quote;
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_onScroll);
    final api = ref.read(apiProvider);
    if (api == null) {
      _bootError = true;
      return;
    }
    _chat = ChatController(
      api: api,
      workspaceId: widget.workspaceId,
      sessionId: widget.sessionId,
    )..addListener(_onChanged);
    _chat!.load();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _chat?.removeListener(_onChanged);
    _chat?.dispose();
    _scroll.dispose();
    super.dispose();
  }

  /// 切后台断流后回来：先拉一次快照（流里丢的帧以服务端为准）。
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state != AppLifecycleState.resumed) return;
    final chat = _chat;
    if (chat == null || chat.sending) return;
    chat.load();
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final position = _scroll.position;
    _atBottom = (position.maxScrollExtent - position.pixels) < 80;
  }

  void _onChanged() {
    if (!mounted) return;
    setState(() {});
    if (_atBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) return;
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final device = ref.watch(currentDeviceProvider);
    final videoEnabled = ref.watch(crewVideoProvider);
    final chat = _chat;
    final quote = _quote;
    final evidenceCount = quote == null
        ? null
        : countEvidence(chat?.session?.messages ?? const [], quote.messageId);

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
                title: quote != null ? '回复' : (chat?.session?.displayTitle ?? '会话'),
                num: quote != null ? 'QUOTE' : 'CHAT',
                subtitle: [
                  device?.name,
                  quote != null
                      ? quote.stage.label
                      : (widget.workspaceId == null ? '不归属任何舱' : '舱会话'),
                ].whereType<String>().join(' · '),
                onBack: () => context.pop(),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                actions: [
                  BarIconButton(
                    onTap: () => _chat?.load(),
                    child: const Icon(Icons.refresh, size: 16, color: Octo.metal2),
                  ),
                ],
              ),
              if (quote != null)
                QuoteBar(
                  quote: quote,
                  evidenceCount: evidenceCount,
                  onClose: () => setState(() => _quote = null),
                ),
              Expanded(child: _buildBody(chat, videoEnabled)),
              Composer(
                placeholder: quote == null ? '说点什么…' : '回复上面这个问题…',
                helper: quote == null
                    ? null
                    : '说清楚就行：清掉 / 先别动 / 只删 spec 不动验收清单',
                sending: chat?.sending ?? false,
                enabled: chat != null && !_bootError,
                chips: const ['继续', '停下', '看 diff', '切到验收'],
                onSend: (text) async {
                  await chat?.send(text);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildBody(ChatController? chat, bool videoEnabled) {
    if (chat == null) {
      return const ErrorState(
        error: '还没选设备 —— 回设备列表挑一台机器',
      );
    }
    if (chat.loading && chat.session == null) {
      return const LoadingState(label: '正在拉会话…');
    }
    if (chat.loadError != null && chat.session == null) {
      return Center(
        child: ErrorState(error: chat.loadError!, onRetry: () => chat.load()),
      );
    }

    final session = chat.session;
    final messages = <ChatMessage>[...?session?.messages];
    final pending = chat.pendingUserText;
    if (pending != null && pending.isNotEmpty) {
      messages.add(ChatMessage(
        id: '__pending__',
        sessionId: chat.sessionId,
        role: 'user',
        type: 'text',
        content: pending,
        createdAt: '',
        meta: const {'displayType': 'user'},
      ));
    }
    final live = chat.live;
    final showEmpty = messages.isEmpty && !live.hasAnything;

    return ListView(
      controller: _scroll,
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(14, 4, 14, 12),
      children: [
        if (live.errorMessage != null && !chat.sending) ...[
          ErrorState(
            error: live.errorMessage!,
            compact: true,
            onRetry: () => chat.load(),
          ),
          const SizedBox(height: 10),
        ],
        if (showEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 40),
            child: EmptyState(
              title: '在这儿说点什么',
              detail: '机器上的文件、舱里的状态都能问\n说清楚要干什么，它自己找路',
              artwork: CrewFigure(height: 230, videoEnabled: videoEnabled),
            ),
          ),
        TuiTranscript(
          messages: messages,
          live: live.hasAnything ? live : null,
        ),
        if (chat.sending)
          const Padding(
            padding: EdgeInsets.only(top: 2, bottom: 6),
            child: Text(
              '… 流式输出中',
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10,
                letterSpacing: .6,
                color: Octo.faint,
              ),
            ),
          ),
      ],
    );
  }
}
