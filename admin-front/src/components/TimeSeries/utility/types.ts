export enum ResolutionValues {
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}
export type Resolution =
  | ResolutionValues.HOUR
  | ResolutionValues.DAY
  | ResolutionValues.WEEK
  | ResolutionValues.MONTH;

export type Month =
  | 'All'
  | 'January'
  | 'February'
  | 'March'
  | 'April'
  | 'May'
  | 'June'
  | 'July'
  | 'August'
  | 'September'
  | 'October'
  | 'November'
  | 'December';

export interface TimeSeriesRecord {
  timestamp: number;
  value: number;
}

export type TimeSeries = TimeSeriesRecord[];

export interface Occurrence {
  year: number;
  month: Month;
}

export type TimeSeriesType = 'nftCount' | 'priceVolume';
