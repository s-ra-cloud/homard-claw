export type RetiredAgentLocationInput = {
  id: string;
  retiredAt: string;
};

export const HOTEL_GUEST_CAPACITY = 10;

/**
 * Give every retired agent one stable vacation location.
 *
 * The API returns newest retirements first. Sorting oldest-first before
 * alternating locations means a newly retired agent is appended without
 * moving every existing guest between the beach and hotel.
 */
export function partitionRetiredAgents<T extends RetiredAgentLocationInput>(
  retiredAgents: readonly T[],
): { beachAgents: T[]; hotelAgents: T[] } {
  const ordered = [...retiredAgents].sort((left, right) => {
    const timeDifference =
      new Date(left.retiredAt).getTime() - new Date(right.retiredAt).getTime();
    return timeDifference || left.id.localeCompare(right.id);
  });
  const beachAgents: T[] = [];
  const hotelAgents: T[] = [];

  ordered.forEach((agent, index) => {
    if (index % 2 === 1 && hotelAgents.length < HOTEL_GUEST_CAPACITY) {
      hotelAgents.push(agent);
    } else {
      beachAgents.push(agent);
    }
  });

  return { beachAgents, hotelAgents };
}
