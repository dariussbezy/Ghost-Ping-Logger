package app.dariuss.logger;

import android.text.SpannableStringBuilder;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;

/** Runs against the real Android text implementation with adb shell dalvikvm. */
public final class HistoryStyleCheck {
    public static void main(String[] args) {
        SpannableStringBuilder text = new SpannableStringBuilder(
            "\ue100-65536;First\ue101 \ue102-65536;(edited 18:55)\ue103\n" +
            "\ue100-16711936;Second\ue101 \ue102-16711936;(edited 18:56)\ue103\nLatest"
        );
        HistoryStyle.applyRanges(text, '\ue100', '\ue101', false);
        HistoryStyle.applyRanges(text, '\ue102', '\ue103', true);
        if (!text.toString().equals("First (edited 18:55)\nSecond (edited 18:56)\nLatest"))
            throw new AssertionError(text.toString());
        RelativeSizeSpan[] sizes = text.getSpans(0, text.length(), RelativeSizeSpan.class);
        if (sizes.length != 2) throw new AssertionError("Expected two compact labels");
        for (RelativeSizeSpan span : sizes) {
            String label = text.subSequence(text.getSpanStart(span), text.getSpanEnd(span)).toString();
            if (span.getSizeChange() != 0.75f || !label.startsWith("(edited ") || !label.endsWith(")"))
                throw new AssertionError("Invalid label range: " + label);
        }
        int latest = text.toString().indexOf("Latest");
        if (text.getSpans(latest, text.length(), ForegroundColorSpan.class).length != 0)
            throw new AssertionError("Current message was colored");
        HistoryStyle.applyRanges(text, '\ue100', '\ue101', false);
        HistoryStyle.applyRanges(text, '\ue102', '\ue103', true);
        if (text.getSpans(0, text.length(), RelativeSizeSpan.class).length != 2)
            throw new AssertionError("Two loggers duplicated the label styles");
        System.out.println("Android spans verified: per-edit colors, 75% labels, unchanged current text, idempotent hooks");
    }
}
