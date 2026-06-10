#!/bin/bash
cd /Users/michaelofengenden/Desktop/ResearchPubs/data/tmp/arxiv-reasoning
queries=(
'%22chain%20of%20thought%22%20reasoning%20language%20model'
'%22reasoning%20model%22%20OR%20%22test-time%20compute%22%20OR%20%22inference-time%20scaling%22'
'%22chain-of-thought%20faithfulness%22%20OR%20%22CoT%20monitoring%22'
'language%20model%20reasoning%20mathematics%20olympiad'
)
sleep 20  # cool down from earlier 429
for i in 1 2 3 4; do
  q="${queries[$((i-1))]}"
  url="https://export.arxiv.org/api/query?search_query=all:${q}&sortBy=submittedDate&sortOrder=descending&max_results=150"
  for attempt in 1 2 3 4 5; do
    code=$(curl -sL -w "%{http_code}" "$url" -o "q${i}.xml")
    n=$(grep -c '<entry>' "q${i}.xml" 2>/dev/null || echo 0)
    echo "query $i attempt $attempt: HTTP $code, entries $n" >> fetch.log
    if [ "$code" = "200" ] && [ "$n" -gt 0 ]; then break; fi
    sleep $((15 * attempt))
  done
  sleep 5
done
echo DONE >> fetch.log
