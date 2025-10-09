export function setLocalStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    if (
      window.syncToFirestore &&
      window.firebaseReady &&
      window.firebaseAuth &&
      window.firebaseAuth.currentUser
    ) {
      setTimeout(() => {
        window
          .syncToFirestore(key, value)
          .catch((err) =>
            console.warn(`Firestore sync failed for ${key}:`, err)
          );
      }, 0);
    }
  } catch (error) {
    console.error(`Error in setLocalStorage for key ${key}:`, error);
  }
}

export function getLocalStorage(key, defaultValue = null) {
  const raw = localStorage.getItem(key);
  if (raw === null) {
    if (defaultValue !== null) return defaultValue;
    if (key === "savedGames" || key === "freezerGames") return [];
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}
