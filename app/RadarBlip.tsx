import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';

interface BlipProps {
  x: number; // Calculated Cartesian X offset from center
  y: number; // Calculated Cartesian Y offset from center
}

export const RadarBlip: React.FC<BlipProps> = ({ x, y }) => {
  // Animated values tracking the 2D plane positions smoothly
  const animX = useRef(new Animated.Value(x)).current;
  const animY = useRef(new Animated.Value(y)).current;

  useEffect(() => {
    // Run animations in parallel directly on the native OS compositor thread
    Animated.parallel([
      Animated.timing(animX, {
        toValue: x,
        duration: 400, // Smooth transition window matching your scan interval
        useNativeDriver: true, // Crucial for fluid 60FPS performance
      }),
      Animated.timing(animY, {
        toValue: y,
        duration: 400,
        useNativeDriver: true,
      }),
    ]).start();
  }, [x, y]);

  // Use transform translations instead of top/left layout styles to keep it glitch-free
  const animatedStyle = {
    transform: [{ translateX: animX }, { translateY: animY }],
  } as any;

  return (
    <Animated.View style={[styles.blip, animatedStyle]}>
      <View style={styles.innerDot} />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  blip: {
    position: 'absolute',
    width: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  innerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#00e5ff',
    shadowColor: '#00e5ff',
    shadowRadius: 6,
    shadowOpacity: 0.8,
  },
});
