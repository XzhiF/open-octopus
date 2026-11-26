import 'package:flutter/material.dart';

import '../app/theme.dart';
import '../core/http.dart';
import 'panel.dart';

export '../core/http.dart' show describeError;

class LoadingState extends StatelessWidget {
  const LoadingState({super.key, this.label = '正在连那台机器…'});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const SizedBox(
            width: 22,
            height: 22,
            child: CircularProgressIndicator(
              strokeWidth: 1.8,
              valueColor: AlwaysStoppedAnimation(Octo.teal),
            ),
          ),
          const SizedBox(height: 14),
          Text(
            label,
            style: const TextStyle(
              fontFamily: Octo.mono,
              fontSize: 10.5,
              letterSpacing: .5,
              color: Octo.dim,
            ),
          ),
        ],
      ),
    );
  }
}

class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.error, this.onRetry, this.compact = false});

  final Object error;
  final VoidCallback? onRetry;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final message = describeError(error);
    final api = error is ApiException ? error as ApiException : null;
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: 16, vertical: compact ? 12 : 24),
      child: RoundedPanel(
        borderColor: Octo.red.withValues(alpha: .3),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                const Icon(Icons.error_outline, size: 15, color: Octo.red),
                const SizedBox(width: 8),
                Text(
                  api?.isNetwork == true ? '连不上' : '出错了',
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Colors.white,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Text(
              message,
              style: const TextStyle(
                fontFamily: Octo.mono,
                fontSize: 10.5,
                height: 1.7,
                color: Octo.dim,
              ),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 12),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  onPressed: onRetry,
                  style: TextButton.styleFrom(
                    foregroundColor: Octo.teal,
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(999),
                      side: BorderSide(color: Octo.teal.withValues(alpha: .4)),
                    ),
                  ),
                  child: const Text('重试', style: TextStyle(fontSize: 11.5)),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.title,
    this.detail,
    this.artwork,
    this.action,
  });

  final String title;
  final String? detail;
  final Widget? artwork;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (artwork != null) artwork!,
            if (artwork != null) const SizedBox(height: 10),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                letterSpacing: .2,
                color: Colors.white,
              ),
            ),
            if (detail != null) ...[
              const SizedBox(height: 10),
              Text(
                detail!,
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontFamily: Octo.mono,
                  fontSize: 11,
                  height: 1.8,
                  color: Octo.dim,
                ),
              ),
            ],
            if (action != null) ...[const SizedBox(height: 18), action!],
          ],
        ),
      ),
    );
  }
}
