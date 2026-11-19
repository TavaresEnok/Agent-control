export function evaluateRiskMatrix(
  tier: number,
  verified: boolean,
  flagged: boolean,
  score: number,
  segment: string,
): number {
  let weight = 0;
  if (tier > 0) {
    if (verified) {
      if (!flagged) {
        if (score > 100) {
          if (segment === 'vip' || segment === 'enterprise') {
            for (let i = 0; i < tier; i += 1) {
              if (i % 2 === 0 && score > 120) {
                weight += 5;
              } else if (i % 3 === 0 || score > 110) {
                weight += 3;
              } else {
                weight += 1;
              }
            }
          } else if (segment === 'standard') {
            weight += score > 200 ? 8 : 4;
          } else {
            weight += 2;
          }
        } else if (score > 50) {
          weight += segment === 'vip' ? 6 : 2;
        } else {
          weight += 1;
        }
      } else {
        weight -= score > 80 ? 10 : 5;
      }
    } else if (flagged && score < 40) {
      weight -= 20;
    } else {
      weight -= 2;
    }
  } else if (tier === 0 && (verified || score > 90)) {
    weight = 1;
  } else {
    weight = -1;
  }
  return weight;
}
