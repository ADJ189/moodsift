export type Screen = 'landing' | 'quiz' | 'rating' | 'results' | 'search';

export type Genre = 'thriller' | 'comedy' | 'drama' | 'scifi' | 'horror' | 'adventure' | 'anime' | 'cartoon' | 'sitcom';
export type Vibe = 'dark' | 'light' | 'intellectual' | 'feelgood' | 'epic';
export type Era = 'classic' | 'mid' | 'recent' | 'any';
export type Format = 'movie' | 'series' | 'both';
export type Company = 'solo' | 'date' | 'friends' | 'family';
export type Language = 'english' | 'subtitles' | 'any_lang';
/** A separate style dimension from `mood` — lets someone ask specifically
 * for anime, Western animation, or sitcom-style comedy rather than
 * overloading the tone question. 'live_action' means no preference here. */
export type ContentType = 'anime' | 'cartoon' | 'sitcom' | 'live_action';
/** grouped = a wider, more forgiving pool (default). precise = fewer titles,
 * held to a higher match-score bar — quality over quantity. */
export type ResultsMode = 'grouped' | 'precise';

export interface QuizAnswers {
  mood?: Genre;
  format?: Format;
  era?: Era;
  vibe?: Vibe;
  company?: Company;
  language?: Language;
  contentType?: ContentType;
}

export interface QuizOption {
  label: string;
  value: string;
  icon: string;
}

export interface QuizQuestion {
  id: keyof QuizAnswers;
  question: string;
  subtitle: string;
  options: QuizOption[];
  /** Narrows/reorders this question's options based on answers already
   * given, so a later question doesn't offer something that contradicts
   * or just restates an earlier pick (e.g. "light & fun" after "horror"). */
  filterOptions?: (answers: QuizAnswers, options: QuizOption[]) => QuizOption[];
}

/** A title as returned live from TMDB's discover/search endpoints. */
export interface CatalogItem {
  id: number; // TMDB id, used as the canonical id throughout the app
  title: string;
  year: number;
  type: 'movie' | 'series';
  tmdbType: 'movie' | 'tv';
  posterPath: string | null;
  backdropPath: string | null;
  genreIds: number[];
  genres: Genre[]; // mapped to our internal genre vocabulary
  vibe: Vibe[]; // inferred from genre + keywords
  language: string; // ISO 639-1 original_language
  era: Era;
  voteAverage: number; // TMDB rating, 0-10
  voteCount: number;
  popularity: number;
  overview: string;
  externalRatings?: ExternalRatings;
}

export interface ExternalRatings {
  rottenTomatoes?: number; // 0-100
  metacritic?: number; // 0-100
  imdbRating?: number; // 0-10
}

export type FitLevel = 'strong' | 'good' | 'stretch';

export interface ScoredItem extends CatalogItem {
  /** Calibrated absolute fit, 1-99. Independent of what else is in the
   * current batch, so 90% means the same thing on every search. */
  matchPct: number;
  /** Position inside the current batch, 0-100 (100 = top pick). Relative by
   * design — use it for ordering/visual emphasis, never as a "quality %". */
  rankPct: number;
  /** Raw weighted score, kept so the UI can reason about it (e.g. picking
   * hidden gems) without re-deriving anything. */
  score: number;
  fit: FitLevel;
  reasons: string[];
  /** Genres/vibes of this title that the taste profile actually favors —
   * rendered as "why it matched" chips. */
  matchedTags: string[];
}

/** A small, well-known seed list used for the taste-calibration rating step. */
export interface RatingSeed {
  id: number; // TMDB id
  title: string;
  year: number;
  type: 'movie' | 'series';
  tmdbType: 'movie' | 'tv';
  posterPath: string | null;
}

export type RatingValue = 1 | 2 | 3 | 4 | 5;

export interface GenreAffinityMap {
  [key: string]: number;
}

export interface AppState {
  screen: Screen;
  quizAnswers: QuizAnswers;
  /** Keyed by media key (`movie:123` / `tv:123`), never a bare TMDB id. */
  ratings: Record<string, RatingValue>;
  ratingSeeds: RatingSeed[];
  ratingSignals: Record<string, string[]>;
  results: ScoredItem[];
  loading: boolean;
  error: string | null;
  /** Set by "jump to this person/title" actions (e.g. clicking a cast
   * member in the results detail modal) alongside switching to the
   * search screen — search.ts reads and clears this on mount instead of
   * showing an empty search box, since the intent was already explicit. */
  pendingSearchTarget: SearchTarget | null;
}

export type SearchTarget =
  | { kind: 'title'; id: number; tmdbType: 'movie' | 'tv' }
  | { kind: 'person'; id: number }
  /** Opens search with the box pre-filled (command palette). */
  | { kind: 'query'; query: string };

/** A cast or crew credit as returned by /movie|tv/{id}/credits. */
export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface CrewMember {
  id: number;
  name: string;
  job: string;
  profilePath: string | null;
}

export interface Credits {
  cast: CastMember[];
  directors: CrewMember[]; // job === 'Director' (movies) or the show's created_by (tv)
}

/** A person as returned by /search/person. */
export interface PersonSummary {
  id: number;
  name: string;
  profilePath: string | null;
  knownForDepartment: string;
  /** Titles TMDB lists as this person's best known, from the same search
   * response (no extra request). Absent when TMDB sends none. */
  knownFor?: string[];
}

export interface PersonDetails extends PersonSummary {
  biography: string;
  birthday: string | null;
  placeOfBirth: string | null;
}
