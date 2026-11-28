import 'package:flutter/material.dart';

import '../../../app/theme.dart';
import '../../../core/composer_settings.dart';
import 'sheet_shell.dart';

/// 模型设置（原型 E7）：别名 + 每个模型自己的思考强度 / 上下文窗口。
///
/// 选择只改「下一条消息起」的 SDK 选项，不重启会话；抽屉不自动收起，
/// 方便连续调三档。实际运行模型与别名不同时，在 ctx 明细里标注。
Future<void> showModelSheet(
  BuildContext context, {
  required ComposerSettings settings,
  required ValueChanged<String> onModelChanged,
  required ValueChanged<ComposerEffort> onEffortChanged,
  required ValueChanged<ComposerContext> onContextChanged,
}) {
  return showOctoSheet<void>(
    context,
    title: '模型设置',
    num: 'MODEL',
    trailing: '每个模型独立预设',
    maxHeightFactor: .8,
    builder: (ctx) => _ModelSheetBody(
      settings: settings,
      onModelChanged: onModelChanged,
      onEffortChanged: onEffortChanged,
      onContextChanged: onContextChanged,
    ),
  );
}

class _ModelSheetBody extends StatefulWidget {
  const _ModelSheetBody({
    required this.settings,
    required this.onModelChanged,
    required this.onEffortChanged,
    required this.onContextChanged,
  });

  final ComposerSettings settings;
  final ValueChanged<String> onModelChanged;
  final ValueChanged<ComposerEffort> onEffortChanged;
  final ValueChanged<ComposerContext> onContextChanged;

  @override
  State<_ModelSheetBody> createState() => _ModelSheetBodyState();
}

class _ModelSheetBodyState extends State<_ModelSheetBody> {
  late String _model = widget.settings.model;
  late final Map<String, ModelPreset> _presets = {...widget.settings.presets};

  ModelPreset _presetOf(String model) =>
      _presets[model] ?? widget.settings.presetOf(model);

  ModelPreset get _current => _presetOf(_model);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final option in kModelOptions)
          SheetRow(
            icon: '◆',
            title: option.id,
            description: option.desc,
            selected: option.id == _model,
            onTap: () {
              setState(() => _model = option.id);
              widget.onModelChanged(option.id);
            },
            trailing: Column(
              crossAxisAlignment: CrossAxisAlignment.end,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '${_presetOf(option.id).effort.label} · ${_presetOf(option.id).context.shortLabel}',
                  style: const TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9.5,
                    color: Octo.dim,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  option.id == _model ? '当前' : '预设',
                  style: TextStyle(
                    fontFamily: Octo.mono,
                    fontSize: 9,
                    color: option.id == _model ? Octo.teal : Octo.faint,
                  ),
                ),
              ],
            ),
          ),
        const SheetSec('思考强度', trailing: '下一条消息生效'),
        SheetTabs(
          compact: true,
          tabs: [for (final e in ComposerEffort.values) e.label],
          index: ComposerEffort.values.indexOf(_current.effort),
          onChanged: (index) {
            final effort = ComposerEffort.values[index];
            setState(() {
              _presets[_model] = ModelPreset(
                effort: effort,
                context: _current.context,
              );
            });
            widget.onEffortChanged(effort);
          },
        ),
        const SheetSec('上下文窗口'),
        SheetTabs(
          compact: true,
          tabs: [for (final c in ComposerContext.values) c.label],
          index: ComposerContext.values.indexOf(_current.context),
          onChanged: (index) {
            final mode = ComposerContext.values[index];
            setState(() {
              _presets[_model] = ModelPreset(
                effort: _current.effort,
                context: mode,
              );
            });
            widget.onContextChanged(mode);
          },
        ),
        const SheetFoot('只影响本轮及之后；跑动中换模型要等这一轮跑完。实际运行模型与别名不同时，在 ctx 明细里标注。'),
      ],
    );
  }
}
