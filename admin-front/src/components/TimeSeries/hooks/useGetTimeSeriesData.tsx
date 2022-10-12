import { useEffect, useState } from 'react';
import moment from 'moment';
import useGetDataFromAPI from 'shared/hooks/useGetDataFromAPI';
import { getTimeSeriesFilteredByOccurrence } from '../functions/getTimeSeriesFilteredByOccurrence';
import { Month, Resolution } from '../types';

export interface TimeSeriesRecord {
  timestamp: number;
  value: number;
}

interface TimeSeriesData {
  timeStamps: string[];
  timeStampValues: number[];
}

const TimeSeriesPaths = {
  nftCount: '/analytics/sales/nftCount/timeseries',
  priceVolume: '/analytics/sales/priceVolume/timeseries',
};

export type TimeSeriesType = 'nftCount' | 'priceVolume';

interface UseGetTimeSeriesDataProps {
  timeSeriesType: TimeSeriesType;
  resolution: Resolution;
  year: number;
  month: Month;
}

const UseGetTimeSeriesData = ({
  timeSeriesType,
  resolution,
  year,
  month,
}: UseGetTimeSeriesDataProps): TimeSeriesData => {
  const [timeStamps, setTimeStamps] = useState<string[]>([]);
  const [timeStampValues, setTimeStampValues] = useState<number[]>([]);

  const queryStr = resolution ? `?resolution=${resolution}` : undefined;
  const { data: fetchedTimeSeries } = useGetDataFromAPI<TimeSeriesRecord[]>({
    path: TimeSeriesPaths[timeSeriesType],
    queryStr,
  });

  useEffect(() => {
    if (fetchedTimeSeries) {
      const timeSeriesFilteredByOccurrence = getTimeSeriesFilteredByOccurrence({
        timeSeries: fetchedTimeSeries,
        occurrence: { year, month },
      });

      setTimeStamps(
        timeSeriesFilteredByOccurrence.map((record: TimeSeriesRecord) => {
          return moment.unix(record.timestamp).format('MM/DD/YYYY');
        }),
      );

      setTimeStampValues(
        timeSeriesFilteredByOccurrence.map(
          (record: TimeSeriesRecord) => record.value,
        ),
      );
    }
  }, [fetchedTimeSeries, year, month]);

  return {
    timeStamps,
    timeStampValues,
  };
};

export default UseGetTimeSeriesData;
