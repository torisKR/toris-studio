import unittest

from runtime import narration


class NarrationTests(unittest.TestCase):
    def test_tags_switch_tone_speaker_and_pause_per_line(self):
        segments = narration.parse("[차분한 다큐][Ryan] 첫 문장입니다.\n[쉼:800] **핵심** 기능을 봅니다.\n그냥 문장", "Sohee", "natural", 300)
        self.assertEqual([(s.speaker, s.style, s.pause_ms) for s in segments],
                         [("Ryan", "documentary", 300), ("Sohee", "natural", 800), ("Sohee", "natural", 300)])
        self.assertEqual(segments[1].text, "핵심 기능을 봅니다.")
        self.assertEqual(segments[1].highlights, ("핵심",))
        self.assertIn("핵심", narration.instruction(segments[1], "strong"))

    def test_unknown_tags_are_spoken_and_pause_is_capped(self):
        segments = narration.parse("[공지] 오늘 소식\n[쉼:99999] 끝", "Sohee", "natural", 300)
        self.assertEqual(segments[0].text, "[공지] 오늘 소식")
        self.assertEqual(segments[1].pause_ms, narration.MAX_PAUSE_MS)

    def test_long_lines_split_at_sentences_without_losing_text(self):
        sentence = "가" * 200 + "."
        segments = narration.parse(f"{sentence} {sentence} {sentence}", "Sohee", "natural", 300)
        self.assertTrue(all(len(s.text) <= narration.MAX_LINE for s in segments))
        self.assertEqual("".join(s.text for s in segments).replace(" ", ""), (sentence * 3))
        self.assertEqual(segments[-1].pause_ms, 300)

    def test_closed_choices_are_enforced(self):
        with self.assertRaises(ValueError):
            narration.parse("문장", "Unknown", "natural", 300)
        with self.assertRaises(ValueError):
            narration.parse("문장", "Sohee", "shout", 300)
        with self.assertRaises(ValueError):
            narration.parse("   \n**  **", "Sohee", "natural", 300)
        with self.assertRaises(ValueError):
            narration.sampling("max")
        self.assertEqual(narration.sampling("stable")["temperature"], 0.7)


if __name__ == "__main__":
    unittest.main()

