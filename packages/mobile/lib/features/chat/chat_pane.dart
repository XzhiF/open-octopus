import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/composer_settings.dart';
import '../../core/models/chat.dart';
import '../../core/models/quote.dart';
import '../../core/models/telemetry.dart';
import '../../core/providers.dart';
import '../../widgets/composer.dart';
import '../../widgets/crew_animation.dart';
import '../../widgets/quote_bar.dart';
import '../../widgets/states.dart';
import '../../widgets/tui.dart';
import 'chat_controller.dart';
import 'console_bar.dart';
import 'identity_chip.dart';
import 'sheets/core_sheet.dart';
import 'sheets/ctx_sheet.dart';
import 'sheets/model_sheet.dart';
import 'sheets/sheet_shell.dart';
import 'sheets/tok_sheet.dart';
import 'sheets/turns_sheet.dart';

/// 一段会话的主体：引用条 + 通讯台头 + 聊天面板 + 输入区。
///
/// 舱内主 chat（E 屏，立绘站在面板后面）与普通会话（F / G 屏）共用这一份；
/// 顶栏由各自的屏幕画，[ChatPane] 只管从引用条往下。
class ChatPane extends ConsumerStatefulWidget {
  const ChatPane({
    super.key,
    required this.workspaceId,
    required this.sessionId,
    this.cabinId,
    this.cabinName,
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

  /// 舱 id：tok 抽屉底部的「本舱账本」入口（单独会话为 null）。
  final String? cabinId;
  final String? cabinName;

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

class ChatPaneState extends ConsumerState<ChatPane>
    with WidgetsBindingObserver {
  ChatController? _chat;
  final ScrollController _scroll = ScrollController();
  bool _atBottom = true;
  bool _bootError = false;

  /// 星核里挂到下一条消息的技能 / 一次性委派。
  String? _attachedSkill;
  ChatSubagentRef? _attachedSubagent;

  /// 轮次抽屉跳转后的粉闪。
  String? _flashUserId;
  Timer? _flashTimer;
  final Map<String, GlobalKey> _userKeys = {};

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
    _flashTimer?.cancel();
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

  void _snack(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: error
            ? Octo.red.withValues(alpha: .92)
            : const Color(0xF21B1638),
      ),
    );
  }

  ChatSendOptions _sendOptions(ComposerSettings settings) => ChatSendOptions(
    model: settings.model,
    effort: settings.current.effort.id,
    maxContext: settings.current.context.id,
    skill: _attachedSkill,
    subagent: _attachedSubagent,
  );

  Future<void> _send(String text) async {
    final chat = _chat;
    if (chat == null) return;
    final settings = ref.read(composerSettingsProvider);
    await chat.send(text, options: _sendOptions(settings));
    if (!mounted) return;
    // 挂载与委派都是一次性的：随这条消息消费掉。
    if (_attachedSkill != null || _attachedSubagent != null) {
      setState(() {
        _attachedSkill = null;
        _attachedSubagent = null;
      });
    }
  }

  /// 会话命令（/compact、/clear、/autocompact）不携带技能与委派。
  Future<void> _sendCommand(String command) async {
    final chat = _chat;
    if (chat == null) return;
    final settings = ref.read(composerSettingsProvider);
    await chat.send(
      command,
      options: ChatSendOptions(
        model: settings.model,
        effort: settings.current.effort.id,
        maxContext: settings.current.context.id,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final chat = _chat;
    final quote = widget.quote;
    final videoEnabled = ref.watch(crewVideoProvider);
    final settings = ref.watch(composerSettingsProvider);
    final evidenceCount = quote == null
        ? null
        : countEvidence(chat?.session?.messages ?? const [], quote.messageId);
    final role = chat?.role ?? const SessionRole();

    return Column(
      children: [
        if (quote != null)
          QuoteBar(
            quote: quote,
            evidenceCount: evidenceCount,
            onClose: widget.onQuoteClosed,
          ),
        if (widget.agent && chat != null)
          ConsoleBar(
            model: settings.model,
            contextUsage: chat.contextUsage,
            usage: chat.usage,
            turns: _turnsOf(chat).length,
            onCoreTap: () => _openCore(chat, 0),
            onModelTap: () => _openModel(settings),
            onCtxTap: () => _openCtx(chat, settings.model),
            onTokTap: () => _openTok(chat),
            onTurnsTap: () => _openTurns(chat),
          ),
        Expanded(child: _buildBody(chat, videoEnabled)),
        Composer(
          placeholder: quote == null
              ? widget.placeholder
              : widget.quotePlaceholder,
          helper: quote == null ? null : widget.quoteHelper,
          sending: chat?.sending ?? false,
          enabled: chat != null && !_bootError,
          chips: widget.chips,
          controls: widget.agent
              ? ChatIdentityChip(
                  role: role,
                  skill: _attachedSkill,
                  subagent: _attachedSubagent,
                  onTap: chat == null ? null : () => _openCore(chat, 1),
                  onClear: () => _clearRole(chat!),
                  onSkillClear: () => setState(() => _attachedSkill = null),
                  onSubagentClear: () =>
                      setState(() => _attachedSubagent = null),
                )
              : null,
          onSend: _send,
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
        child: ErrorState(
          error: '${chat.loadError}',
          onRetry: () => chat.load(),
        ),
      );
    }

    final session = chat.session;
    final messages = <ChatMessage>[...?session?.messages];
    final pending = chat.pendingUserText;
    if (pending != null && pending.isNotEmpty) {
      messages.add(
        ChatMessage(
          id: '__pending__',
          sessionId: chat.sessionId,
          role: 'user',
          type: 'text',
          content: pending,
          createdAt: '',
          meta: const {'displayType': 'user'},
        ),
      );
    }
    final live = chat.live;
    final showEmpty = messages.isEmpty && !live.hasAnything;

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
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
    final userKeys = <String, GlobalKey>{};
    for (final message in messages) {
      if (!message.isUser || message.isEvent || message.id == '__pending__') {
        continue;
      }
      userKeys[message.id] = _userKeys.putIfAbsent(
        message.id,
        () => GlobalKey(),
      );
    }

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
                    turnStats: chat.turnStats,
                    userKeys: userKeys,
                    flashUserId: _flashUserId,
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

  // ── 通讯台抽屉 ──────────────────────────────────────────────────────

  List<TurnEntry> _turnsOf(ChatController chat) {
    final entries = <TurnEntry>[];
    final messages = chat.session?.messages ?? const <ChatMessage>[];
    for (final message in messages) {
      if (!message.isUser || message.isEvent) continue;
      entries.add(
        TurnEntry(
          id: message.id,
          index: entries.length + 1,
          text: message.content,
          createdAt: message.createdAt,
        ),
      );
    }
    return entries;
  }

  Future<void> _openCore(ChatController chat, int initialTab) async {
    if (!mounted) return;
    await showCoreSheet(
      context,
      chat: chat,
      initialTab: initialTab,
      attachedSkill: _attachedSkill,
      attachedSubagent: _attachedSubagent,
      onSkillChanged: (skill) => setState(() => _attachedSkill = skill),
      onSubagentChanged: (subagent) =>
          setState(() => _attachedSubagent = subagent),
      onCompact: () => _sendCommand('/compact'),
      onClear: () => _sendCommand('/clear'),
      onAutocompact: () => _sendCommand('/autocompact'),
      onRename: _rename,
      onExport: _export,
    );
  }

  Future<void> _openModel(ComposerSettings settings) async {
    if (!mounted) return;
    final notifier = ref.read(composerSettingsProvider.notifier);
    await showModelSheet(
      context,
      settings: settings,
      onModelChanged: (model) => notifier.selectModel(model),
      onEffortChanged: (effort) => notifier.setEffort(effort),
      onContextChanged: (mode) => notifier.setContext(mode),
    );
  }

  Future<void> _openCtx(ChatController chat, String aliasModel) async {
    final ctx = chat.contextUsage;
    if (ctx == null) {
      _snack('还没有上下文读数 —— 发一条消息后由 SDK 校准');
      return;
    }
    await showCtxSheet(
      context,
      usage: ctx,
      session: chat.usage,
      aliasModel: aliasModel,
      onCompact: () => _sendCommand('/compact'),
    );
  }

  Future<void> _openTok(ChatController chat) async {
    final cabinId = widget.cabinId;
    await showTokSheet(
      context,
      usage: chat.usage,
      onCabinLedger: cabinId == null
          ? null
          : () async {
              try {
                final usage = await chat.api.cabinUsage(cabinId);
                if (!mounted) return;
                await showCabinLedgerSheet(
                  context,
                  usage: usage,
                  cabinName: widget.cabinName,
                );
              } catch (e) {
                _snack(describeError(e), error: true);
              }
            },
    );
  }

  Future<void> _openTurns(ChatController chat) async {
    final turns = _turnsOf(chat);
    if (turns.isEmpty) {
      _snack('还没有轮次 —— 先说一句');
      return;
    }
    final id = await showTurnsSheet(context, turns: turns);
    if (id == null || !mounted) return;
    await _jumpToTurn(id);
  }

  Future<void> _jumpToTurn(String messageId) async {
    final context = _userKeys[messageId]?.currentContext;
    if (context == null) return;
    await Scrollable.ensureVisible(
      context,
      alignment: .32,
      duration: const Duration(milliseconds: 380),
      curve: Curves.easeOutCubic,
    );
    if (!mounted) return;
    _flashTimer?.cancel();
    setState(() => _flashUserId = messageId);
    _flashTimer = Timer(const Duration(milliseconds: 1100), () {
      if (!mounted) return;
      setState(() => _flashUserId = null);
    });
  }

  Future<void> _clearRole(ChatController chat) async {
    try {
      await chat.setRole(null);
      _snack('已回到主 Agent');
    } catch (e) {
      _snack(describeError(e), error: true);
    }
  }

  Future<void> _rename(String title) async {
    final chat = _chat;
    if (chat == null) return;
    try {
      await chat.rename(title);
      _snack('已改名为「$title」');
    } catch (e) {
      _snack(describeError(e), error: true);
    }
  }

  Future<void> _export() async {
    final messages = _chat?.session?.messages ?? const <ChatMessage>[];
    final lines = <String>[];
    // 从后往前数 20 条真人发言，再按原顺序输出。
    var users = 0;
    var start = messages.length;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].isUser && !messages[i].isEvent) {
        users++;
        if (users > 20) break;
        start = i;
      }
    }
    for (final message in messages.skip(start)) {
      if (message.isUser && !message.isEvent) {
        lines.add('❯ ${message.content}');
      } else if (message.displayType == 'text' &&
          message.content.trim().isNotEmpty) {
        lines.add('✦ 汐音：${message.content}');
      }
    }
    await copyToClipboard(lines.join('\n\n'));
    _snack('已复制最近 ${users.clamp(0, 20)} 轮到剪贴板');
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
