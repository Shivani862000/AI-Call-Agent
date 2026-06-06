function getGreeting(now = new Date()) {
  const hour = now.getHours();

  if (hour >= 6 && hour < 12) {
    return 'Good Morning';
  }

  if (hour >= 12 && hour < 17) {
    return 'Good Afternoon';
  }

  if (hour >= 17 && hour < 22) {
    return 'Good Evening';
  }

  return 'Namaste';
}

module.exports = { getGreeting };
