// 本机联调冒烟：不开模拟器也能验证「端点 + 解析」这条链。
//
//   flutter pub get
//   dart run tool/smoke.dart http://127.0.0.1:3001
//
// 只读：列舱 / 读 attention / 列会话 / 读最近一条会话 / 列任务。
// 发消息（会真的让 agent 干活）用 --send "文字" 显式开。
import 'dart:io';

import 'package:octopus_mobile/core/api.dart';
import 'package:octopus_mobile/core/models/chat.dart';
import 'package:octopus_mobile/core/models/quote.dart';

Future<void> main(List<String> args) async {
  final base = args.isNotEmpty && !args.first.startsWith('--')
      ? args.first
      : 'http://127.0.0.1:3001';
  final sendIndex = args.indexOf('--send');
  final sendText = sendIndex >= 0 && args.length > sendIndex + 1 ? args[sendIndex + 1] : null;
  final showAttention = args.contains('--attention');

  final api = OctopusApi(base);
  stdout.writeln('→ $base');

  try {
    final cabins = await api.cabins();
    stdout.writeln('cabins: ${cabins.length}');
    for (final cabin in cabins) {
      final detail = await api.attention(cabin.id);
      final list = detail.attentionList;
      stdout.writeln(
        '  · ${cabin.name}  [${cabin.status}]  '
        'wait=${detail.waitCount} review=${detail.reviewCount} running=${detail.health.running}'
        '  attention=${list.length}  ws=${cabin.workspaceId ?? '-'}',
      );
      for (final a in list) {
        final q = SessionQuote.fromAttention(a);
        stdout.writeln(
          '    · ${a.stage.label} · ${a.subjectName}  [${a.sourceLine}]'
          '${a.ask == null ? '' : '  ask=${a.ask!.askId}'}',
        );
        stdout.writeln('      q: ${_clip(q.question, 100)}');
        if (showAttention) {
          stdout.writeln(
            '      key=${a.dedupeKey} handle=${a.handle ?? '-'} '
            'phase=${a.phaseLabel ?? '-'} msg=${a.ask?.messageId ?? '-'}',
          );
        }
      }

      final tasks = await api.tasks(cabinId: cabin.id);
      stdout.writeln('    tasks: ${tasks.length}'
          '${tasks.isEmpty ? '' : ' (${tasks.first.name} · ${tasks.first.status})'}');

      final ws = cabin.workspaceId;
      if (ws != null) {
        final sessions = await api.sessions(ws);
        stdout.writeln('    sessions: ${sessions.length}');
        if (sessions.isNotEmpty) {
          final ChatSession latest = sessions.first;
          final full = await api.session(ws, latest.id, limit: 20);
          stdout.writeln(
            '    latest: "${full.displayTitle}" messages=${full.messages.length}/${full.totalMessageCount}',
          );
          for (final m in full.messages.takeLast(3)) {
            stdout.writeln('      ${m.role}/${m.displayType}: ${_clip(m.content, 60)}');
          }
        }

        if (sendText != null && sessions.isNotEmpty) {
          final sid = sessions.first.id;
          stdout.writeln('→ send to ${sessions.first.displayTitle}: $sendText');
          var events = 0;
          await for (final ev in api.sendMessage(
            workspaceId: ws,
            sessionId: sid,
            content: sendText,
          )) {
            events++;
            if (ev.event == 'text_delta') {
              stdout.write((ev.json?['content'] as String?) ?? '');
            } else if (ev.event == 'error') {
              stdout.writeln('\nerror: ${ev.data}');
            } else if (ev.event == 'result') {
              stdout.writeln('\nresult: ${_clip(ev.data, 160)}');
            }
          }
          stdout.writeln('\nevents: $events');
        }
      }
    }

    final globalSessions = await api.sessions(null);
    stdout.writeln('global sessions: ${globalSessions.length}');

    if (args.contains('--session-roundtrip')) {
      final ws = cabins.isEmpty ? null : cabins.first.workspaceId;
      if (ws != null) {
        stdout.writeln('→ session roundtrip on ${cabins.first.name}');
        final created = await api.createSession(ws, title: 'smoke · 可删');
        stdout.writeln('  created: ${created.id} title="${created.title}"');
        final fetched = await api.session(ws, created.id);
        stdout.writeln('  fetched: messages=${fetched.messages.length} total=${fetched.totalMessageCount}');
        final listed = await api.sessions(ws);
        stdout.writeln('  listed: ${listed.length}');
        await api.deleteSession(ws, created.id);
        stdout.writeln('  deleted');
      }
    }

    final eventsArg = args.firstWhere((a) => a.startsWith('--events'), orElse: () => '');
    if (eventsArg.isNotEmpty) {
      final secs = eventsArg.contains('=')
          ? (int.tryParse(eventsArg.split('=').last) ?? 2)
          : 2;
      final ws = cabins.isEmpty ? null : cabins.first.workspaceId;
      if (ws != null) {
        stdout.writeln('→ workspace events (${ws.length > 8 ? ws.substring(0, 8) : ws}…) for ${secs}s');
        var count = 0;
        final sub = api.workspaceEvents(ws).listen((ev) {
          count++;
          stdout.writeln('  sse ${ev.event} ${_clip(ev.data, 80)}');
        }, onError: (Object e) => stdout.writeln('  sse error: $e'));
        await Future<void>.delayed(Duration(seconds: secs));
        await sub.cancel();
        stdout.writeln('  events: $count');
      }
    }

    final cabinEventsArg =
        args.firstWhere((a) => a.startsWith('--cabin-events'), orElse: () => '');
    if (cabinEventsArg.isNotEmpty && cabins.isNotEmpty) {
      final secs = cabinEventsArg.contains('=')
          ? (int.tryParse(cabinEventsArg.split('=').last) ?? 2)
          : 2;
      final cabinId = cabins.first.id;
      stdout.writeln('→ cabin events (${cabins.first.name}) for ${secs}s');
      var count = 0;
      final sub = api.cabinEvents(cabinId).listen((ev) {
        count++;
        stdout.writeln('  sse ${ev.event} ${_clip(ev.data, 80)}');
      }, onError: (Object e) => stdout.writeln('  sse error: $e'));
      await Future<void>.delayed(Duration(seconds: secs));
      await sub.cancel();
      stdout.writeln('  events: $count');
    }

    stdout.writeln('\nOK');
  } catch (e, st) {
    stderr.writeln('FAILED: $e');
    stderr.writeln(st);
    exitCode = 1;
  } finally {
    api.close();
  }
}

String _clip(String s, int max) {
  final oneLine = s.replaceAll(RegExp(r'\s+'), ' ').trim();
  return oneLine.length <= max ? oneLine : '${oneLine.substring(0, max)}…';
}

extension<T> on List<T> {
  Iterable<T> takeLast(int n) => skip(length - n < 0 ? 0 : length - n);
}
