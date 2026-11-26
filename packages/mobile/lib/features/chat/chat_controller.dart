import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../core/api.dart';
import '../../core/http.dart';
import '../../core/models/chat.dart';
import '../../core/models/sse.dart';

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
  });

  final OctopusApi api;
  final String? workspaceId;
  final String sessionId;

  ChatSession? session;
  Object? loadError;
  bool loading = true;
  bool sending = false;

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
      session = await api.session(workspaceId, sessionId);
    } catch (e) {
      loadError = e;
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<void> send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty || sending) return;

    sending = true;
    pendingUserText = trimmed;
    live = LiveTurn()..started = true;
    _notify();

    final cancel = CancelToken();
    _cancel = cancel;

    try {
      final stream = api.sendMessage(
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
      final fresh = await api.session(workspaceId, sessionId);
      if (_disposed) return;
      session = fresh;
      live = LiveTurn();
      pendingUserText = null;
      _notify();
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
        l.started = true;
        break;
      case 'text_delta':
      case 'local_command_output':
        l.started = true;
        l.text += (data?['content'] as String?) ?? '';
        break;
      case 'thinking':
        l.thinking += (data?['content'] as String?) ?? '';
        break;
      case 'thinking_done':
        l.thinkingDuration = data?['thinkingDuration'] as String?;
        break;
      case 'tool_call':
        final id = (data?['toolCallId'] as String?) ?? '';
        final name = (data?['toolName'] as String?) ?? 'tool';
        final input = data?['toolInput'];
        final inputText = input == null ? null : _encode(input);
        final existing = l.tools.indexWhere((t) => t.id == id);
        if (existing >= 0) {
          l.tools[existing]
            ..inputText = inputText ?? l.tools[existing].inputText
            ..status = 'running';
        } else {
          l.tools.add(LiveTool(id: id, name: name, inputText: inputText));
        }
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
        l.done = true;
        l.numTurns = (data?['numTurns'] as num?)?.toInt();
        l.applyUsage((data?['usage'] as Map?)?.cast<String, dynamic>());
        l.costUsd = (data?['costUsd'] as num?)?.toDouble();
        final content = data?['content'] as String?;
        if (l.text.isEmpty && content != null && content.isNotEmpty) {
          l.text = content;
        }
        break;
      case 'error':
        l.errorMessage = (data?['message'] as String?) ?? '出错了';
        l.errorCode = data?['code'] as String?;
        l.done = true;
        break;
      default:
        // heartbeat / message_delta / context_usage … 手机端不需要
        break;
    }
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
