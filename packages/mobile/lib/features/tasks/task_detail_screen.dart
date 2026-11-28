import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/format.dart';
import '../../core/models/task.dart';
import '../../core/nav.dart';
import '../../core/providers.dart';
import '../../widgets/octo_bar.dart';
import '../../widgets/panel.dart';
import '../../widgets/scene_background.dart';
import '../../widgets/states.dart';

/// 任务详情（只读）。手机不改任务：触发 / 验收 / 归档都在电脑上。
class TaskDetailScreen extends ConsumerWidget {
  const TaskDetailScreen({super.key, required this.taskId});

  final String taskId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final taskAsync = ref.watch(taskDetailProvider(taskId));

    return Scaffold(
      backgroundColor: Octo.screen,
      body: SceneBackground(
        asset: SceneBackground.deepspace,
        child: SafeArea(
          child: Column(
            children: [
              OctoBar(
                title: taskAsync.value?.name ?? '任务',
                num: 'TASK',
                subtitle: taskAsync.value == null
                    ? null
                    : (taskStatusLabels[taskAsync.value!.status] ?? taskAsync.value!.status),
                onBack: () => back(context),
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              ),
              Expanded(
                child: taskAsync.when(
                  loading: () => const LoadingState(label: '正在拉任务…'),
                  error: (error, _) => Center(
                    child: ErrorState(
                      error: error,
                      onRetry: () => ref.invalidate(taskDetailProvider(taskId)),
                    ),
                  ),
                  data: (task) => _TaskBody(task: task),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TaskBody extends StatelessWidget {
  const _TaskBody({required this.task});

  final TaskItem task;

  @override
  Widget build(BuildContext context) {
    final tone = taskTone(task.status);
    final color = switch (tone) {
      TaskTone.run => Octo.teal,
      TaskTone.wait => Octo.amber,
      TaskTone.review => Octo.pink,
      TaskTone.bad => Octo.red,
      TaskTone.neutral => Octo.metal2,
    };

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 2, 16, 24),
      children: [
        Row(
          children: [
            StatusPill(label: taskStatusLabels[task.status] ?? task.status, color: color),
            const Spacer(),
            Text(
              '只读',
              style: TextStyle(
                fontFamily: Octo.mono,
                fontSize: 9,
                letterSpacing: .8,
                color: Octo.faint.withValues(alpha: .9),
              ),
            ),
          ],
        ),
        const SizedBox(height: 14),
        if (task.goal != null) ...[
          const SectionTitle('目标'),
          const SizedBox(height: 10),
          RoundedPanel(
            child: Text(
              task.goal!,
              style: const TextStyle(fontSize: 13, height: 1.65, color: Octo.ink),
            ),
          ),
          const SizedBox(height: 16),
        ],
        if (task.phases.isNotEmpty) ...[
          SectionTitle('阶段 · ${task.phases.length}'),
          const SizedBox(height: 10),
          for (var i = 0; i < task.phases.length; i++) ...[
            RoundedPanel(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
              child: Row(
                children: [
                  Container(
                    width: 22,
                    height: 22,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(7),
                      border: Border.all(color: Octo.teal.withValues(alpha: .3)),
                    ),
                    child: Text(
                      '${i + 1}',
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 10,
                        color: Octo.teal,
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      task.phases[i].name,
                      style: const TextStyle(fontSize: 12.5, color: Colors.white),
                    ),
                  ),
                  if (task.phases[i].workflowRef != null)
                    Text(
                      task.phases[i].workflowRef!,
                      style: const TextStyle(
                        fontFamily: Octo.mono,
                        fontSize: 9,
                        color: Octo.dim,
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
          ],
          const SizedBox(height: 8),
        ],
        if (task.acceptance.isNotEmpty) ...[
          SectionTitle('验收 · ${task.acceptance.length}'),
          const SizedBox(height: 10),
          RoundedPanel(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final line in task.acceptance)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 6),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          '· ',
                          style: TextStyle(
                            fontFamily: Octo.mono,
                            fontSize: 11,
                            color: Octo.teal,
                          ),
                        ),
                        Expanded(
                          child: Text(
                            line,
                            style: const TextStyle(
                              fontSize: 12,
                              height: 1.6,
                              color: Octo.ink2,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
        if (task.semanticSummary != null && task.semanticSummary!.trim().isNotEmpty) ...[
          const SectionTitle('摘要'),
          const SizedBox(height: 10),
          RoundedPanel(
            child: Text(
              task.semanticSummary!,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.7,
                color: Octo.dim,
              ),
            ),
          ),
          const SizedBox(height: 16),
        ],
        RoundedPanel(
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _kv('创建', formatStamp(task.createdAt)),
              const SizedBox(height: 6),
              _kv('更新', formatStamp(task.updatedAt)),
              if (task.repoGroup != null) ...[
                const SizedBox(height: 6),
                _kv('仓库', task.repoGroup!),
              ],
              const SizedBox(height: 6),
              _kv('编号', task.id),
            ],
          ),
        ),
      ],
    );
  }

  Widget _kv(String k, String v) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 46,
          child: Text(
            k,
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 9.5,
              letterSpacing: .5,
              color: Octo.faint,
            ),
          ),
        ),
        Expanded(
          child: Text(
            v,
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10,
              height: 1.5,
              color: Octo.dim,
            ),
          ),
        ),
      ],
    );
  }
}
