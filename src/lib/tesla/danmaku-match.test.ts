import {
  buildTeslaDanmakuFileName,
  buildTeslaDanmakuSearchKeywords,
  cleanTeslaDanmakuTitle,
  inferTeslaDanmakuSeason,
  rankTeslaDanmakuCandidates,
  selectTeslaDanmakuCandidate,
  selectTeslaDanmakuEpisode,
} from './danmaku-match';

describe('Tesla danmaku automatic match identity', () => {
  test('removes the player display suffix', () => {
    expect(cleanTeslaDanmakuTitle('用书卷一梦 - 2025 - 第 3 集')).toBe(
      '用书卷一梦'
    );
  });

  test('infers a Chinese season marker', () => {
    expect(inferTeslaDanmakuSeason('庆余年 第二季')).toBe(2);
  });

  test('searches both the displayed season title and the base programme title', () => {
    expect(buildTeslaDanmakuSearchKeywords('庆余年 第二季')).toEqual([
      '庆余年 第二季',
      '庆余年',
    ]);
  });

  test('builds the filename expected by the automatic match API', () => {
    expect(
      buildTeslaDanmakuFileName({
        title: '庆余年 第二季',
        year: '2024',
        episode: 7,
      })
    ).toBe('庆余年 第二季 (2024) S02E07');
  });

  test('builds a generic movie filename without any title-specific rule', () => {
    expect(
      buildTeslaDanmakuFileName({
        title: '流浪地球2 - 2023',
        year: '2023',
        episode: 1,
      })
    ).toContain('流浪地球2');
  });

  test('selects the real 2011 series instead of a misleading first result', () => {
    const selected = selectTeslaDanmakuCandidate(
      [
        {
          animeId: 294824,
          animeTitle: '揭秘甄嬛传(2026)',
          startDate: '2026-01-01',
          typeDescription: '电视剧',
          episodeCount: 10,
        },
        {
          animeId: 34411,
          animeTitle: '后宫甄嬛传(2011)',
          startDate: '2011-11-17',
          typeDescription: '电视剧',
          episodeCount: 76,
        },
      ],
      {
        title: '甄嬛传',
        year: '2011',
        mediaType: 'tv',
        totalEpisodes: 76,
      }
    );
    expect(selected?.animeId).toBe(34411);
  });

  test('refuses an ambiguous low-confidence fuzzy match', () => {
    expect(
      selectTeslaDanmakuCandidate(
        [
          { animeId: 1, animeTitle: '某剧解说' },
          { animeId: 2, animeTitle: '某剧剪辑' },
        ],
        { title: '某剧' }
      )
    ).toBeNull();
  });

  test('keeps several reliable candidates so an empty first result can fall through', () => {
    expect(
      rankTeslaDanmakuCandidates(
        [
          { animeId: 1, animeTitle: '庆余年 第二季', episodeCount: 36 },
          { animeId: 2, animeTitle: '庆余年 第二季(2024)', episodeCount: 36 },
        ],
        {
          title: '庆余年 第二季',
          year: '2024',
          mediaType: 'tv',
          totalEpisodes: 36,
        }
      ).map((item) => item.animeId)
    ).toHaveLength(2);
  });

  test('prefers explicit episode numbers and rejects unordered unknown lists', () => {
    const episodes = [
      { episodeTitle: '第1集' },
      { episodeTitle: 'S01E02' },
      { episodeTitle: 'EP03' },
    ];
    expect(selectTeslaDanmakuEpisode(episodes, 2)?.episodeTitle).toBe('S01E02');
    expect(
      selectTeslaDanmakuEpisode(
        [{ episodeTitle: '特别篇B' }, { episodeTitle: '特别篇A' }],
        2
      )
    ).toBeNull();
  });

  test('uses the real source episode label over the playlist array index', () => {
    const episodes = [
      { episodeTitle: '第1集' },
      { episodeTitle: '第2集' },
      { episodeTitle: '第3集' },
    ];
    expect(selectTeslaDanmakuEpisode(episodes, 2, '第3集')).toBe(
      episodes[2]
    );
  });
});
