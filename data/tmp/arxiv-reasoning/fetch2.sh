#!/bin/bash
cd /Users/michaelofengenden/Desktop/ResearchPubs/data/tmp/arxiv-reasoning
UA="ResearchPubsCollector/0.1 (mailto:michaelofengend@gmail.com)"
queries=(
'%22chain%20of%20thought%22%20reasoning%20language%20model'
'%22reasoning%20model%22%20OR%20%22test-time%20compute%22%20OR%20%22inference-time%20scaling%22'
'%22chain-of-thought%20faithfulness%22%20OR%20%22CoT%20monitoring%22'
'language%20model%20reasoning%20mathematics%20olympiad'
)
echo "$(date) cooling down 300s" >> fetch2.log
sleep 300
for i in 1 2 3 4; do
  q="${queries[$((i-1))]}"
  url="https://export.arxiv.org/api/query?search_query=all:${q}&sortBy=submittedDate&sortOrder=descending&max_results=150"
  for attempt in 1 2 3; do
    code=$(curl -sL -A "$UA" -D "h${i}.txt" -w "%{http_code}" "$url" -o "q${i}.xml")
    n=$(grep -c '<entry>' "q${i}.xml" 2>/dev/null)
    echo "$(date) query $i attempt $attempt: HTTP $code entries $n retry-after: $(grep -i retry-after h${i}.txt | tr -d '\r')" >> fetch2.log
    if [ "$code" = "200" ] && [ "${n:-0}" -gt 0 ]; then break; fi
    sleep 180
  done
  sleep 10
done
echo "$(date) DONE2" >> fetch2.log
