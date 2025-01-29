/**
 * Sets up a recurring callback that executes at random intervals between specified bounds.
 * Each time the callback executes, a new random interval is generated for the next execution.
 *
 * @param callback - The function to be executed at random intervals
 * @param lowerBoundMs - The minimum interval duration in milliseconds
 * @param upperBoundMs - The maximum interval duration in milliseconds
 * @returns A Timer object that can be used to clear the interval with clearTimeout()
 * @throws {Error} If lowerBoundMs is greater than upperBoundMs
 *
 * @example
 * const timer = randomInterval(
 *   () => console.log('Random tick!'),
 *   1000,    // Minimum 1 second
 *   5000     // Maximum 5 seconds
 * );
 *
 * // Later: clearTimeout(timer) to stop
 */
export const randomInterval = (
  callback: () => void,
  lowerBoundMs: number,
  upperBoundMs: number,
): NodeJS.Timer => {
  if (lowerBoundMs > upperBoundMs) {
    throw new Error("Lower bound cannot be greater than upper bound.");
  }
  // Function to generate a random interval within the specified bounds
  const getRandomInterval = () =>
    Math.floor(Math.random() * (upperBoundMs - lowerBoundMs + 1)) +
    lowerBoundMs;

  const runWithRandomInterval = () => {
    callback(); // Execute the callback
    clearTimeout(timer); // Clear the current timer
    const nextInterval = getRandomInterval(); // Generate a new random interval
    timer = setTimeout(runWithRandomInterval, nextInterval); // Set up the next execution
  };

  let timer = setTimeout(runWithRandomInterval, getRandomInterval()); // Start the first interval
  return timer;
};
