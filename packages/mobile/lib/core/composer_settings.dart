/// 模型 / 思考强度 / 最大上下文（原型 E7）。与桌面 `composer-settings.ts` 同义：
/// 三个别名 pro-max / pro / se，每个模型记住自己的预设；1M 通过模型名 `[1m]`
/// 变体启用（服务端 `resolveChatModel` 负责拼后缀）。
library;

import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers.dart';
import 'storage.dart';

enum ComposerEffort {
  low('low', '低'),
  medium('medium', '标准'),
  high('high', '高'),
  max('max', '极深');

  const ComposerEffort(this.id, this.label);

  final String id;
  final String label;

  static ComposerEffort fromId(String? id) =>
      values.firstWhere((e) => e.id == id, orElse: () => ComposerEffort.high);
}

enum ComposerContext {
  k200('200k', '200K', '默认窗口'),
  k1m('1m', '1M · 长上下文', '模型变体 [1m]');

  const ComposerContext(this.id, this.label, this.hint);

  final String id;
  final String label;
  final String hint;

  /// 行尾预设用的短名（200K / 1M）。
  String get shortLabel => this == ComposerContext.k1m ? '1M' : '200K';

  static ComposerContext fromId(String? id) =>
      values.firstWhere((e) => e.id == id, orElse: () => ComposerContext.k200);
}

class ModelPreset {
  const ModelPreset({required this.effort, required this.context});

  final ComposerEffort effort;
  final ComposerContext context;

  Map<String, dynamic> toJson() => {'effort': effort.id, 'context': context.id};

  factory ModelPreset.fromJson(Map<String, dynamic> json) => ModelPreset(
    effort: ComposerEffort.fromId(json['effort'] as String?),
    context: ComposerContext.fromId(json['context'] as String?),
  );
}

/// 桌面端三个模型别名的展示文案（顺序即抽屉里的顺序）。
class ModelOption {
  const ModelOption(this.id, this.desc, this.effortHint, this.contextHint);

  final String id;
  final String desc;
  final String effortHint;
  final String contextHint;
}

const kModelOptions = <ModelOption>[
  ModelOption('pro-max', '最强 · 复杂重构与 Spec 共建', '极高 · 1M', '极深 · 1M'),
  ModelOption('pro', '均衡 · 日常执行', '标准 · 200K', '高 · 200K'),
  ModelOption('se', '轻量 · 快，走查与轻任务', '低 · 200K', '低 · 200K'),
];

const _defaultPresets = <String, ModelPreset>{
  'pro-max': ModelPreset(
    effort: ComposerEffort.max,
    context: ComposerContext.k1m,
  ),
  'pro': ModelPreset(
    effort: ComposerEffort.high,
    context: ComposerContext.k200,
  ),
  'se': ModelPreset(effort: ComposerEffort.low, context: ComposerContext.k200),
};

const _fallbackPreset = ModelPreset(
  effort: ComposerEffort.high,
  context: ComposerContext.k200,
);

class ComposerSettings {
  const ComposerSettings({this.model = 'pro-max', this.presets = const {}});

  final String model;

  /// 每个模型自己的预设（用户改过才在这里，未改过走 [_defaultPresets]）。
  final Map<String, ModelPreset> presets;

  ModelPreset presetOf(String model) =>
      presets[model] ?? _defaultPresets[model] ?? _fallbackPreset;

  ModelPreset get current => presetOf(model);

  ComposerSettings copyWith({
    String? model,
    Map<String, ModelPreset>? presets,
  }) => ComposerSettings(
    model: model ?? this.model,
    presets: presets ?? this.presets,
  );

  Map<String, dynamic> toJson() => {
    'model': model,
    'presets': presets.map((k, v) => MapEntry(k, v.toJson())),
  };

  factory ComposerSettings.fromJson(Map<String, dynamic> json) {
    final rawPresets = json['presets'];
    final presets = <String, ModelPreset>{};
    if (rawPresets is Map) {
      for (final entry in rawPresets.entries) {
        final value = entry.value;
        if (value is Map) {
          presets['${entry.key}'] = ModelPreset.fromJson(
            value.cast<String, dynamic>(),
          );
        }
      }
    }
    final model = (json['model'] as String?) ?? 'pro-max';
    return ComposerSettings(model: model, presets: presets);
  }
}

class ComposerSettingsNotifier extends Notifier<ComposerSettings> {
  static const _key = 'octopus.composer.v1';

  Store get _store => ref.read(storeProvider);

  @override
  ComposerSettings build() {
    final raw = _store.prefs.getString(_key);
    if (raw == null || raw.isEmpty) return const ComposerSettings();
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map) {
        return ComposerSettings.fromJson(decoded.cast<String, dynamic>());
      }
    } catch (_) {
      // 坏偏好不拖垮聊天：按默认模型开。
    }
    return const ComposerSettings();
  }

  Future<void> _persist(ComposerSettings next) async {
    state = next;
    await _store.prefs.setString(_key, jsonEncode(next.toJson()));
  }

  Future<void> selectModel(String model) =>
      _persist(state.copyWith(model: model));

  Future<void> setEffort(ComposerEffort effort) {
    final current = state.current;
    final presets = {
      ...state.presets,
      state.model: ModelPreset(effort: effort, context: current.context),
    };
    return _persist(state.copyWith(presets: presets));
  }

  Future<void> setContext(ComposerContext context) {
    final current = state.current;
    final presets = {
      ...state.presets,
      state.model: ModelPreset(effort: current.effort, context: context),
    };
    return _persist(state.copyWith(presets: presets));
  }
}

final composerSettingsProvider =
    NotifierProvider<ComposerSettingsNotifier, ComposerSettings>(
      ComposerSettingsNotifier.new,
    );
