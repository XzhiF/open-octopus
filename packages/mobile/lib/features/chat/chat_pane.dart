import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/models/chat.dart';
import '../../core/models/quote.dart';
import '../../core/providers.dart';
import '../../widgets/composer.dart';
import '../../widgets/crew_animation.dart';
import '../../widgets/quote_bar.dart';
import '../../widgets/states.dart';
import '../../widgets/tui.dart';
import 'chat_controller.dart';

/// 一段会话的主体：引用条 + 聊天面板 + 输入区。
///
/// 舱内主 chat（E 屏，立绘站在面板后面）与普通会话（F / G 屏）共用这一份；
/// 顶栏由各自的屏幕画，[ChatPane] 只管从引用条往下。
class ChatPane extends ConsumerStatefulWidget {
  const ChatPane({
    super.key,
    required this.workspaceId,
    required this.sessionId,
    this.quote,
    this.onQuoteClosed,
    this.onSessionLoaded,
    this.agent = false,
    this.crewBehind = false,
    this.fleetHint = false,
    this.chips = const ['继续', '停下', '看 diff', '切到验收'],
    this.placeholder = '说点什么…',
    this.quotePlaceholder = '回复上面这个问题…',
    this.quoteHelper = '说清楚就行：清掉 / 先别动 / 只删 spec 不动验收清单',
  });

  final String? workspaceId;
  final String sessionId;

  /// 从「待你定」点进来的那一问（见 [SessionQuote]）。
  final SessionQuote? quote;
  final VoidCallback? onQuoteClosed;

  /// 快照换了就通知一次（顶栏标题跟着会话走）。
  final ValueChanged<ChatSession?>? onSessionLoaded;

  /// 舱会话走 `/api/agent`（sessions 表）；单独会话仍走旧的 chat/sessions。
  final bool agent;

  /// 立绘站在聊天面板后面右侧（原型方案 A）。关掉「立绘动画」时整块不画。
  final bool crewBehind;

  /// 消息流末尾补一句「待你定 / 会话 / 任务 → 右上角『☰ 编队』」。
  final bool fleetHint;

  final List<String> chips;
  final String placeholder;
  final String quotePlaceholder;
  final String quoteHelper;

  @override
  ChatPaneState createState() => ChatPaneState();
}

class ChatPaneState extends ConsumerState<ChatPane> with WidgetsBindingObserver {
  ChatController? _chat;
  final ScrollController _scroll = ScrollController();
  bool _atBottom = true;
  bool _bootError = false;

  /// 顶栏「刷新」按这里。
  void reload() => _chat?.load();

  @override
  void initState() {
    super.initState();
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
      agent: widget.agent,
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
    widget.onSessionLoaded?.call(_chat?.session);
    if (_atBottom) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) return;
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final chat = _chat;
    final quote = widget.quote;
    final videoEnabled = ref.watch(crewVideoProvider);
    final evidenceCount = quote == null
        ? null
        : countEvidence(chat?.session?.messages ?? const [], quote.messageId);

    return Column(
      children: [
        if (quote != null)
          QuoteBar(
            quote: quote,
            evidenceCount: evidenceCount,
            onClose: widget.onQuoteClosed,
          ),
        Expanded(child: _buildBody(chat, videoEnabled)),
        Composer(
          placeholder: quote == null ? widget.placeholder : widget.quotePlaceholder,
          helper: quote == null ? null : widget.quoteHelper,
          sending: chat?.sending ?? false,
          enabled: chat != null && !_bootError,
          chips: widget.chips,
          onSend: (text) async {
            await chat?.send(text);
          },
        ),
      ],
    );
  }

  Widget _buildBody(ChatController? chat, bool videoEnabled) {
    if (chat == null) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: ErrorState(error: '还没选设备 —— 回设备列表挑一台机器'),
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

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 0),
      child: Stack(
        fit: StackFit.expand,
        children: [
          // 方案 A：她站在聊天面板后面右侧，消息列满宽压在她身上。
          if (widget.crewBehind) CrewBackdrop(animated: videoEnabled),
          _ChatPanel(
            soft: widget.crewBehind,
            child: showEmpty
                ? _emptyPanel(videoEnabled)
                : _transcriptPanel(chat, messages, live),
          ),
        ],
      ),
    );
  }

  Widget _emptyPanel(bool videoEnabled) {
    // 主 chat 里立绘已经在面板后面了，空态不再来一张；单独会话用 09-smile（原型 H）。
    final artwork = widget.crewBehind || !videoEnabled
        ? null
        : const CrewFigure(height: 230, initialIndex: 2, cycleOnTap: false);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
        child: EmptyState(
          title: '在这儿说点什么',
          detail: '机器上的文件、舱里的状态都能问\n说清楚要干什么，它自己找路',
          artwork: artwork,
        ),
      ),
    );
  }

  Widget _transcriptPanel(
    ChatController chat,
    List<ChatMessage> messages,
    LiveTurn live,
  ) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return SingleChildScrollView(
          controller: _scroll,
          physics: const AlwaysScrollableScrollPhysics(),
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: constraints.maxHeight),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 13, 12, 13),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                // 消息不满一屏时贴着面板底（原型 justify-content:flex-end）。
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  if (live.errorMessage != null && !chat.sending) ...[
                    ErrorState(
                      error: live.errorMessage!,
                      compact: true,
                      onRetry: () => chat.load(),
                    ),
                    const SizedBox(height: 10),
                  ],
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
                  if (widget.fleetHint)
                    const Padding(
                      padding: EdgeInsets.only(top: 2),
                      child: Text(
                        '待你定 / 会话 / 任务 → 右上角「☰ 编队」',
                        style: TextStyle(
                          fontFamily: Octo.mono,
                          fontSize: 10,
                          height: 1.6,
                          color: Octo.faint,
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }
}

/// 聊天面板：圆角玻璃 + 青边 + 顶缘渐隐（原型 `.stream`）。
/// [soft] 是舱内主 chat 的淡色版 —— 后面站着立绘，面板只压暗不遮死。
class _ChatPanel extends StatelessWidget {
  const _ChatPanel({required this.child, this.soft = false});

  final Widget child;
  final bool soft;

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      blendMode: BlendMode.dstIn,
      shaderCallback: (rect) => const LinearGradient(
        begin: Alignment.topCenter,
        end: Alignment.bottomCenter,
        stops: [0, .14],
        colors: [Colors.transparent, Colors.black],
      ).createShader(rect),
      child: Container(
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(Octo.rL),
          border: Border.all(color: const Color(0x242EE6D6)),
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: soft
                ? const [Color(0x330A0818), Color(0x5C0A0818)]
                : const [Color(0x6B0A0818), Color(0xA30A0818)],
          ),
        ),
        child: child,
      ),
    );
  }
}
