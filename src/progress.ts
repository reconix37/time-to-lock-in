export interface ProgressDay {
  local_date: string;
  useful_ms: number;
  neutral_ms: number;
  waste_ms: number;
  observed_ms: number;
  useful_goal_min: number;
  waste_limit_min: number;
  observed_min: number;
  useful_passed: boolean;
  waste_passed: boolean;
  observed_passed: boolean;
  passed: boolean;
  useful_level: 0 | 1 | 2 | 3 | 4;
  waste_level: 0 | 1 | 2 | 3 | 4;
  future: boolean;
}

export interface ProgressOverview {
  today: ProgressDay;
  lifetime_xp: number;
  current_rank: string;
  current_rank_threshold: number;
  next_rank: string | null;
  next_rank_threshold: number | null;
  calendar: ProgressDay[];
}
