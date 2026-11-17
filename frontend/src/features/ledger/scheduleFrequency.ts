import type { ScheduleFrequency } from '../../api/types'

export const SCHEDULE_FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'once', label: 'Once' }, { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' }, { value: 'every_other_week', label: 'Every other week' },
  { value: 'every_four_weeks', label: 'Every 4 weeks' }, { value: 'monthly', label: 'Monthly' },
  { value: 'every_two_months', label: 'Every other month' }, { value: 'every_three_months', label: 'Every 3 months' },
  { value: 'every_four_months', label: 'Every 4 months' }, { value: 'twice_yearly', label: 'Twice a year' },
  { value: 'yearly', label: 'Yearly' }, { value: 'every_two_years', label: 'Every other year' },
]

export function scheduleFrequencyLabel(frequency: string) {
  return SCHEDULE_FREQUENCIES.find((option) => option.value === frequency)?.label
}
