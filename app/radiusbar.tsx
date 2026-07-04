import React, { useCallback, useMemo, useRef } from 'react';
import { LayoutChangeEvent, PanResponder, StyleSheet, Text, View } from 'react-native';

type RadiusBarProps = {
  min?: number;
  max?: number;
  value: number;
  onChange: (v: number) => void;
  width?: number;
};

export function RadiusBar({ min = 1, max = 100, value, onChange, width = 200 }: RadiusBarProps) {
  const barWidthRef = useRef(width);
  const trackLeftRef = useRef<number | null>(null);
  const clamp = useCallback((n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n)), []);
  const THUMB_SIZE = 22;

  const valueToX = useCallback(
    (v: number) => {
      const ratio = (v - min) / (max - min);
      return (barWidthRef.current - THUMB_SIZE) * ratio;
    },
    [min, max],
  );

  const handleTouch = useCallback(
    (absoluteX: number) => {
      if (trackLeftRef.current === null) return;
      const localX = absoluteX - trackLeftRef.current - THUMB_SIZE / 2;
      const maxScrollableWidth = Math.max(0, barWidthRef.current - THUMB_SIZE);
      const clampedX = clamp(localX, 0, maxScrollableWidth);
      const ratio = maxScrollableWidth === 0 ? 0 : clampedX / maxScrollableWidth;
      const raw = min + ratio * (max - min);
      onChange(Math.round(raw * 10) / 10);
    },
    [min, max, clamp, onChange],
  );

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    barWidthRef.current = e.nativeEvent.layout.width;
  }, []);

  const thumbX = useMemo(() => valueToX(value), [value, valueToX]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (evt) => {
          trackLeftRef.current = evt.nativeEvent.pageX - evt.nativeEvent.locationX;
          handleTouch(evt.nativeEvent.pageX);
        },
        onPanResponderMove: (evt) => {
          handleTouch(evt.nativeEvent.pageX);
        },
        onPanResponderRelease: () => {
          trackLeftRef.current = null;
        },
      }),
    [handleTouch],
  );

  return (
    <View style={styles.sliderRow}>
      <Text style={styles.edgeText}>{min}m</Text>
      <View style={[styles.track, { width }]} onLayout={onLayout} {...panResponder.panHandlers}>
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              borderRadius: THUMB_SIZE / 2,
              top: (8 - THUMB_SIZE) / 2,
              transform: [{ translateX: clamp(thumbX, 0, Math.max(0, barWidthRef.current - THUMB_SIZE)) }],
            },
          ]}
        />
      </View>
      <Text style={styles.edgeText}>{max}m</Text>
    </View>
  );
}

export default RadiusBar;

const styles = StyleSheet.create({
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 12, width: '100%', paddingHorizontal: 20, marginTop: 12 },
  edgeText: { color: '#7FA2B8', fontSize: 13, fontWeight: '600', minWidth: 36, textAlign: 'center' },
  track: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#0A2A3A',
    borderWidth: 1,
    borderColor: '#1D5E78',
    position: 'relative',
  },
  thumb: {
    position: 'absolute',
    backgroundColor: '#020C1C',
    borderWidth: 2.5,
    borderColor: '#00E68A',
    left: 0,
    shadowColor: '#00E68A',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 5,
    elevation: 4,
  },
});
