// lib/categories.js — the category list used by the bot (admin buttons + #hashtag matching) for BOTH YouTube videos and channel movies.
// To add a new category: add one line here, redeploy. (The app also shows any category the admin types by hand.)
export const CATEGORIES = [
    ['Islamic', '🕌'], ['Drama', '🎭'], ['Movie', '🎬'], ['Anime', '🍥'], ['Manga/Manhwa', '📚'],
    ['Documentary', '🎞️'], ['Series', '📺'], ['Cartoon/Kids', '🧸'], ['Bangla', '🇧🇩'], ['Hindi', '🇮🇳'],
    ['Hollywood', '🎥'], ['K-Drama', '🇰🇷'], ['Comedy', '😂'], ['Action', '💥'], ['Horror', '👻'],
    ['Romance', '💕'], ['Sci-Fi', '🚀'], ['Thriller', '🕵️'], ['Music', '🎵'], ['Education', '🎓'],
    ['Motivation', '💪'], ['Technology', '💻'], ['Gaming', '🎮'], ['Sports', '⚽'], ['Cooking', '🍳'],
    ['Travel', '✈️'], ['Nature', '🌿'], ['News', '📰'], ['Health', '🩺'], ['History', '🏛️'],
    ['Science', '🔬'], ['Podcast', '🎙️'], ['Other', '📁'],
];

// inline keyboard of every category, 2 per row. callback_data = prefix + index (short, safe for Telegram's 64-byte limit)
export function categoryKeyboard(prefix) {
    const rows = [];
    for (let i = 0; i < CATEGORIES.length; i += 2) {
        rows.push(CATEGORIES.slice(i, i + 2).map(([name, emoji], k) => ({ text: `${emoji} ${name}`, callback_data: `${prefix}${i + k}` })));
    }
    return { inline_keyboard: rows };
}

const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const ALIASES = { manga: 'Manga/Manhwa', manhwa: 'Manga/Manhwa', manhua: 'Manga/Manhwa', doc: 'Documentary', docs: 'Documentary', documentaries: 'Documentary',
    kdrama: 'K-Drama', korean: 'K-Drama', kids: 'Cartoon/Kids', cartoon: 'Cartoon/Kids', cartoons: 'Cartoon/Kids', movies: 'Movie', film: 'Movie', films: 'Movie',
    scifi: 'Sci-Fi', islam: 'Islamic', quran: 'Islamic', waz: 'Islamic', dramas: 'Drama', shorts: 'Other', tech: 'Technology' };
// "#anime" / "#Manga_Manhwa" / "#doc" → the real category name (or null if it matches nothing)
export function matchCategory(tag) {
    const n = norm(tag);
    if (!n) return null;
    if (ALIASES[n]) return ALIASES[n];
    for (const [name] of CATEGORIES) {
        if (norm(name) === n || name.split('/').some(p => norm(p) === n)) return name;
    }
    return null;
}
