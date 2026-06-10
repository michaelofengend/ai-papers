#!/bin/zsh
# Paginate q2 (reward hacking/tampering, 508 total) and q4 (RLHF, 1449 total)
# beyond the first 150 recency-sorted results, politely retrying on 429.
cd /Users/michaelofengenden/Desktop/ResearchPubs/tmp/arxiv_alignment || exit 1

fetch() {
  local out=$1 url=$2
  if [ -s "$out" ] && [ "$(wc -c < "$out")" -gt 1000 ]; then
    echo "$out already present, skipping"
    return 0
  fi
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -sL -w '%{http_code}' "$url" -o "$out")
    size=$(wc -c < "$out" | tr -d ' ')
    if [ "$code" = "200" ] && [ "$size" -gt 1000 ]; then
      echo "$out OK ($size bytes)"
      sleep 5
      return 0
    fi
    echo "$out attempt $attempt HTTP $code size $size"
    sleep 60
  done
  echo "$out FAILED"
  return 1
}

Q2='all:%22reward%20hacking%22%20OR%20%22reward%20tampering%22'
Q4='all:%22RLHF%22%20OR%20%22reinforcement%20learning%20from%20human%20feedback%22'

for start in 150 300 450; do
  fetch "q2_s${start}.xml" "https://export.arxiv.org/api/query?search_query=${Q2}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=150"
done
for start in 150 300 450 600 750 900 1050 1200 1350; do
  fetch "q4_s${start}.xml" "https://export.arxiv.org/api/query?search_query=${Q4}&sortBy=submittedDate&sortOrder=descending&start=${start}&max_results=150"
done
echo ALL_DONE
