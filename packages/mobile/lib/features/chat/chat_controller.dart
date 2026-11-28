import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/http.dart';
import '../../core/models/chat.dart';
import '../../core/models/sse.dart';
import '../../core/models/telemetry.dart';
import '../../core/turn_stats.dart';

/// 发一条消息时随行的通讯台设置。
class ChatSendOptions {
  const ChatSendOptions({
    this.model,
    this.effort,
    this.maxContext,
    this.skill,
    this.subagent,
  });

  final String? model;
  final String? effort;
  final String? maxContext;

  /// 星核 · 技能里选中的一把：服务端按斜杠命令消费（`/skill 你的话`）。
  final String? skill;

  /// 星核 · 分身里委派的一次性身份（发送后自动摘掉）。
  final ChatSubagentRef? subagent;
}

/// 一个会话的读取 + 流式发送。跟屏幕同生命周期，不跨页面共享。
///
/// 流是 **POST 响应体内联 SSE**：开头发一句，然后逐帧追加到 [live]；
/// 流结束后重新拉一次快照，让落库的行替代临时态（也顺便拿到服务端补的
/// thinking / tool 行）。切后台断流后回来，同样以快照为准。
class ChatController extends ChangeNotifier {
  ChatController({
    required this.api,
    required this.workspaceId,
    required this.sessionId,
    this.agent = false,
  });

  final OctopusApi api;
  final String? workspaceId;
  final String sessionId;

  /// 舱会话走 /api/agent（sessions 表）；单独会话仍走旧的 chat/sessions。
  final bool agent;

  ChatSession? session;
  Object? loadError;
  bool loading = true;
  bool sending = false;

  /// 通讯台遥测：ctx 芯片 / tok 芯片 / 轮次统计 / 当前身份。
  ContextUsage? contextUsage;
  SessionUsage usage = const SessionUsage();
  Map<String, TurnStats> turnStats = const {};
  SessionRole? role;

  /// CLI 广播过的斜杠命令（进程内缓存）。
  List<String> slashCommands = const [];

  /// 本地乐观显示的这条用户消息（流结束、快照回来后就清掉）。
  String? pendingUserText;

  LiveTurn live = LiveTurn();

  CancelToken? _cancel;
  bool _disposed = false;

  Future<void> load() async {
    loading = true;
    loadError = null;
    _notify();
    try {
      session = agent
          ? await api.agentSession(sessionId)
          : await api.session(workspaceId, sessionId);
      contextUsage = session?.contextUsage;
    } catch (e) {
      loadError = e;
    } finally {
      loading = false;
      _notify();
    }
    // 遥测是增强项：先把会话画出来，身份 / 账本 / 命令表在后台补。
    if (agent && session != null) unawaited(_loadTelemetry());
  }

  /// 身份 + 账本（tok 芯片 / 轮次统计）。失败不拖垮会话流：遥测挂掉时
  /// 芯片显示「--」，消息照常能看能发。
  Future<void> _loadTelemetry() async {
    try {
      role = await api.sessionRole(sessionId);
    } catch (_) {
      // 老服务 / 权限不足：身份贴纸退回主 Agent。
    }
    try {
      final ledger = await api.sessionLedger(sessionId);
      usage = ledger.usage;
      turnStats = buildTurnStats(session?.messages ?? const [], ledger.rows);
    } catch (_) {
      // 账本不可读时保留上一份；连上一份都没有就是 0（UI 显示 --）。
    }
    try {
      slashCommands = await api.slashCommands(sessionId);
    } catch (_) {
      // 命令表是增强项，拿不到就不提示。
    }
    _notify();
  }

  /// 切身份（null = 回主 Agent）。返回更新后的角色；失败抛出给 UI 提示。
  Future<SessionRole> setRole(String? expert) async {
    final next = await api.setSessionRole(sessionId, expert);
    role = next;
    _notify();
    return next;
  }

  Future<void> rename(String title) async {
    await api.renameAgentSession(sessionId, title);
    final current = session;
    if (current != null) {
      session = ChatSession(
        id: current.id,
        workspaceId: current.workspaceId,
        title: title,
        isActive: current.isActive,
        provider: current.provider,
        providerSessionId: current.providerSessionId,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
        messages: current.messages,
        totalMessageCount: current.totalMessageCount,
        contextUsage: current.contextUsage,
      );
    }
    _notify();
  }

  Future<void> send(
    String text, {
    ChatSendOptions options = const ChatSendOptions(),
  }) async {
    var trimmed = text.trim();
    if (trimmed.isEmpty || sending) return;

    // 技能挂载与桌面同款：`/skill-name 你的话`，不覆盖用户自己写的斜杠命令。
    final skill = options.skill;
    if (skill != null &&
        skill.isNotEmpty &&
        !trimmed.startsWith('/') &&
        !trimmed.startsWith('@@')) {
      trimmed = '/$skill $trimmed';
    }

    sending = true;
    pendingUserText = trimmed;
    live = LiveTurn()..started = true;
    _notify();

    final cancel = CancelToken();
    _cancel = cancel;

    try {
      final stream = agent
          ? api.sendAgentMessage(
              sessionId: sessionId,
              content: trimmed,
              model: options.model,
              effort: options.effort,
              maxContext: options.maxContext,
              subagents: options.subagent == null
                  ? const []
                  : [options.subagent!],
              cancelToken: cancel,
            )
          : api.sendMessage(
              workspaceId: workspaceId,
              sessionId: sessionId,
              content: trimmed,
              cancelToken: cancel,
            );
      await for (final event in stream) {
        if (_disposed) break;
        _apply(event);
        _notify();
      }
    } catch (e) {
      if (!_disposed) {
        live.errorMessage = describeError(e);
        live.errorCode = e is ApiException ? e.kind : 'error';
        _notify();
      }
    } finally {
      _cancel = null;
      if (!_disposed) {
        live.done = true;
        sending = false;
        _notify();
        // 不论流是否完整，拿一次快照：断流时它就是唯一的真相。
        await _refreshSnapshot();
      }
    }
  }

  void cancelStream() {
    _cancel?.cancel('用户取消');
  }

  Future<void> _refreshSnapshot() async {
    try {
      final fresh = agent
          ? await api.agentSession(sessionId)
          : await api.session(workspaceId, sessionId);
      if (_disposed) return;
      session = fresh;
      contextUsage = fresh.contextUsage ?? contextUsage;
      live = LiveTurn();
      pendingUserText = null;
      _notify();
      if (agent) await _loadTelemetry();
    } catch (e) {
      if (_disposed) return;
      // 快照失败不吞掉已有内容：把错误挂到 live 上，让用户能重试。
      live.errorMessage ??= describeError(e);
      live.errorCode ??= e is ApiException ? e.kind : 'error';
      _notify();
    }
  }

  void _apply(SseEvent event) {
    final data = event.json;
    final l = live;
    switch (event.event) {
      case 'message_start':
      case 'turn_phase':
        l.started = true;
        break;
      case 'text_delta':
      case 'local_command_output':
        l.started = true;
        // agent 域是 {delta, content(累计)}；旧 chat 域只有 {content}(增量)。
        l.text +=
            (data?['delta'] as String?) ?? (data?['content'] as String?) ?? '';
        break;
      case 'assistant_continue':
        // 后台任务唤醒的续轮：服务端用 separator 把两段话分开。
        final separator = data?['separator'] as String?;
        if (separator != null && separator.isNotEmpty) l.text += separator;
        break;
      case 'thinking':
        l.thinking +=
            (data?['delta'] as String?) ?? (data?['content'] as String?) ?? '';
        break;
      case 'thinking_done':
        l.thinkingDone = true;
        l.thinkingDuration = data?['thinkingDuration'] as String?;
        break;
      case 'ask_user_question':
        final askId = (data?['tool_call_id'] as String?) ?? '';
        if (askId.isNotEmpty && l.tools.every((t) => t.id != askId)) {
          l.tools.add(
            LiveTool(id: askId, name: 'AskUserQuestion', status: 'done'),
          );
        }
        break;
      case 'tool_call':
        _applyToolCall(data);
        break;
      case 'tool_result':
        final resultId = (data?['toolCallId'] as String?) ?? '';
        final index = l.tools.indexWhere((t) => t.id == resultId);
        if (index >= 0) {
          l.tools[index]
            ..status = (data?['isError'] == true) ? 'error' : 'done'
            ..duration = data?['toolDuration'] as String?;
        }
        break;
      case 'result':
      case 'done':
        l.done = true;
        l.numTurns = (data?['numTurns'] as num?)?.toInt();
        l.applyUsage((data?['usage'] as Map?)?.cast<String, dynamic>());
        l.costUsd = (data?['costUsd'] as num?)?.toDouble();
        final content = data?['content'] as String?;
        if (l.text.isEmpty && content != null && content.isNotEmpty) {
          l.text = content;
        }
        break;
      case 'context_usage':
        // 通讯台 ctx 芯片的实时源：SDK 每轮上报一次（含构成 categories）。
        if (data != null) {
          contextUsage = ContextUsage.fromJson(data);
        }
        break;
      case 'slash_commands':
        final commands = data?['commands'];
        if (commands is List) {
          slashCommands = commands.whereType<String>().toList(growable: false);
        }
        break;
      case 'error':
        l.errorMessage = (data?['message'] as String?) ?? '出错了';
        l.errorCode = data?['code'] as String?;
        l.done = true;
        break;
      default:
        // heartbeat / context_usage / status / background_tasks … 手机端不需要
        break;
    }
  }

  /// agent 域的 tool_call 是一条事件带三种 `type`：start / input / result。
  void _applyToolCall(Map<String, dynamic>? data) {
    final l = live;
    final type = data?['type'] as String?;
    final id =
        (data?['tool_call_id'] as String?) ??
        (data?['toolCallId'] as String?) ??
        '';
    if (id.isEmpty) return;
    final name =
        (data?['tool_name'] as String?) ??
        (data?['toolName'] as String?) ??
        'tool';
    final index = l.tools.indexWhere((t) => t.id == id);

    if (type == 'result') {
      if (index >= 0) {
        l.tools[index].status = data?['is_error'] == true ? 'error' : 'done';
      }
      return;
    }

    final input = data?['input'] ?? data?['toolInput'];
    final inputText = input == null ? null : _encode(input);
    if (index >= 0) {
      l.tools[index]
        ..inputText = inputText ?? l.tools[index].inputText
        ..status = type == 'start' ? 'running' : l.tools[index].status;
    } else {
      l.tools.add(
        LiveTool(id: id, name: name, inputText: inputText, status: 'running'),
      );
    }
    l.started = true;
  }

  static String _encode(Object value) {
    try {
      return jsonEncode(value);
    } catch (_) {
      return value.toString();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _cancel?.cancel('dispose');
    super.dispose();
  }
}
