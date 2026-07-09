"""
ingest.py
Full production ingestion script for Cricket DuckDB database.
Processes all JSON files from cricsheet_json_data/.
Writes to cricket.duckdb.
Incremental — safe to re-run. Already-ingested files are skipped.
Per-file transactions — no partial ingestion possible.
"""

import json
import logging
import requests
import zipfile
import io
from collections import defaultdict
from pathlib import Path

import duckdb

import alerts

try:
    from tqdm import tqdm
except ImportError:
    raise SystemExit("tqdm is required. Install it with: pip3 install tqdm")

BOWLER_WICKET_KINDS = {
    "bowled", "lbw", "caught", "caught and bowled",
    "stumped", "hit wicket"
}

# ── Paths ─────────────────────────────────────────────────────────────────────
JSON_DIR = Path("data/json")
DB_PATH  = Path("data/cricket.duckdb")
LOG_PATH = Path("data/ingest.log")

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)s  %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, mode="w"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)



# ── Cricsheet download ────────────────────────────────────────────────────────

def download_cricsheet():
    url = "https://cricsheet.org/downloads/all_json.zip"
    log.info(f"Downloading Cricsheet data from {url}...")
    response = requests.get(url, stream=True, timeout=(30, 300))
    response.raise_for_status()
    JSON_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(response.content)) as z:
        json_files = [f for f in z.namelist() if f.endswith('.json')]
        log.info(f"Found {len(json_files)} JSON files in zip")
        new_files = 0
        for filename in json_files:
            dest = JSON_DIR / Path(filename).name
            if not dest.exists():
                with z.open(filename) as src, open(dest, 'wb') as dst:
                    dst.write(src.read())
                new_files += 1
    log.info(f"Cricsheet download complete — {new_files} new files extracted")


# ── Schema ────────────────────────────────────────────────────────────────────
SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS player_registry (
        player_id   VARCHAR PRIMARY KEY,
        player_name VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS officials_registry (
        official_id   VARCHAR PRIMARY KEY,
        official_name VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS matches (
        match_id             VARCHAR PRIMARY KEY,
        match_type           VARCHAR,
        gender               VARCHAR,
        season               VARCHAR,
        season_year_start    INTEGER,
        season_year_end      INTEGER,
        city                 VARCHAR,
        venue                VARCHAR,
        match_date_1         DATE,
        match_date_2         DATE,
        match_date_3         DATE,
        match_date_4         DATE,
        match_date_5         DATE,
        match_date_6         DATE,
        balls_per_over       INTEGER,
        overs                INTEGER,
        team_type            VARCHAR,
        team_1               VARCHAR,
        team_2               VARCHAR,
        toss_winner          VARCHAR,
        toss_decision        VARCHAR,
        toss_uncontested     BOOLEAN,
        event_name           VARCHAR,
        event_match_number   INTEGER,
        event_group          VARCHAR,
        event_stage          VARCHAR,
        event_sub_name       VARCHAR,
        winner               VARCHAR,
        result_type          VARCHAR,
        result_margin        INTEGER,
        result_margin_type   VARCHAR,
        method               VARCHAR,
        supersubs            JSON,
        bowl_out             JSON,
        missing_fields       JSON,
        meta                 JSON
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS ingested_files (
        file_name VARCHAR PRIMARY KEY,
        match_id  VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS match_dates_overflow (
        match_id    VARCHAR REFERENCES matches(match_id),
        day_number  INTEGER,
        match_date  DATE,
        PRIMARY KEY (match_id, day_number)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS innings (
        match_id          VARCHAR REFERENCES matches(match_id),
        innings_number    INTEGER,
        batting_team      VARCHAR,
        declared          BOOLEAN,
        forfeited         BOOLEAN,
        super_over        BOOLEAN,
        target_runs       INTEGER,
        target_overs      FLOAT,
        penalty_runs_pre  INTEGER,
        penalty_runs_post INTEGER,
        miscounted_overs  JSON,
        absent_hurt       JSON,
        PRIMARY KEY (match_id, innings_number)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS powerplays (
        match_id        VARCHAR,
        innings_number  INTEGER,
        powerplay_index INTEGER,
        from_over       FLOAT,
        to_over         FLOAT,
        type            VARCHAR,
        PRIMARY KEY (match_id, innings_number, powerplay_index),
        FOREIGN KEY (match_id, innings_number) REFERENCES innings(match_id, innings_number)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS deliveries (
        match_id            VARCHAR,
        innings_number      INTEGER,
        over_number         INTEGER,
        ball_index          INTEGER,
        batter              VARCHAR,
        batter_id           VARCHAR,
        bowler              VARCHAR,
        bowler_id           VARCHAR,
        non_striker         VARCHAR,
        non_striker_id      VARCHAR,
        runs_batter         INTEGER,
        runs_extras         INTEGER,
        runs_total          INTEGER,
        is_not_boundary     BOOLEAN,
        wides               INTEGER,
        noballs             INTEGER,
        byes                INTEGER,
        legbyes             INTEGER,
        penalty             INTEGER,
        wicket_count        TINYINT,
        wicket_kind         VARCHAR,
        player_out          VARCHAR,
        player_out_id       VARCHAR,
        data_quality_flag   VARCHAR,
        review_by           VARCHAR,
        review_umpire       VARCHAR,
        review_batter       VARCHAR,
        review_decision     VARCHAR,
        review_type         VARCHAR,
        review_umpires_call BOOLEAN,
        replacements        JSON,
        PRIMARY KEY (match_id, innings_number, over_number, ball_index),
        FOREIGN KEY (match_id, innings_number) REFERENCES innings(match_id, innings_number)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS wickets (
        match_id       VARCHAR,
        innings_number INTEGER,
        over_number    INTEGER,
        ball_index     INTEGER,
        wicket_index   INTEGER,
        player_out     VARCHAR,
        player_out_id  VARCHAR,
        kind           VARCHAR,
        PRIMARY KEY (match_id, innings_number, over_number, ball_index, wicket_index)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS wicket_fielders (
        match_id       VARCHAR,
        innings_number INTEGER,
        over_number    INTEGER,
        ball_index     INTEGER,
        wicket_index   INTEGER,
        fielder_index  INTEGER,
        fielder_name   VARCHAR,
        fielder_id     VARCHAR,
        substitute     BOOLEAN,
        PRIMARY KEY (match_id, innings_number, over_number, ball_index, wicket_index, fielder_index)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS match_players (
        match_id    VARCHAR REFERENCES matches(match_id),
        team        VARCHAR,
        player_name VARCHAR,
        player_id   VARCHAR,
        PRIMARY KEY (match_id, team, player_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS match_player_of_match (
        match_id    VARCHAR REFERENCES matches(match_id),
        player_name VARCHAR,
        player_id   VARCHAR,
        PRIMARY KEY (match_id, player_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS officials (
        match_id      VARCHAR REFERENCES matches(match_id),
        official_name VARCHAR,
        official_id   VARCHAR,
        role          VARCHAR
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS innings_batters (
        match_id                        VARCHAR,
        innings_number                  INTEGER,
        batting_position                INTEGER,
        batter                          VARCHAR,
        batter_id                       VARCHAR,
        entry_point                     INTEGER,
        exit_point                      INTEGER,
        out                             VARCHAR,
        dismissal_kind                  VARCHAR,
        batting_partners                INTEGER,
        runs                            INTEGER,
        balls_faced                     INTEGER,
        dots                            INTEGER,
        ones                            INTEGER,
        twos                            INTEGER,
        threes                          INTEGER,
        fours                           INTEGER,
        non_boundary_fours              INTEGER,
        fives                           INTEGER,
        sixes                           INTEGER,
        non_boundary_sixes              INTEGER,
        non_boundary_runs               INTEGER,
        sr                              FLOAT,
        dot_pct                         FLOAT,
        boundary_run_pct                FLOAT,
        non_boundary_run_pct            FLOAT,
        non_boundary_sr                 FLOAT,
        bpb                             FLOAT,
        bp4                             FLOAT,
        bp6                             FLOAT,
        balls_faced_pct                 FLOAT,
        team_relative_sr                FLOAT,
        team_relative_dot_pct           FLOAT,
        team_relative_bpb               FLOAT,
        team_relative_non_boundary_sr   FLOAT,
        window_relative_sr              FLOAT,
        window_relative_dot_pct         FLOAT,
        window_relative_bpb             FLOAT,
        window_relative_non_boundary_sr FLOAT,
        PRIMARY KEY (match_id, innings_number, batting_position)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS innings_bowlers (
        match_id                        VARCHAR,
        innings_number                  INTEGER,
        bowler                          VARCHAR,
        bowler_id                       VARCHAR,
        first_over                      FLOAT,
        last_over                       FLOAT,
        spell_count                     INTEGER,
        overs_bowled                    FLOAT,
        balls                           INTEGER,
        runs_conceded                   INTEGER,
        wide_runs                       INTEGER,
        noball_runs                     INTEGER,
        dots                            INTEGER,
        fours                           INTEGER,
        sixes                           INTEGER,
        maidens                         INTEGER,
        wickets                         INTEGER,
        wickets_bowled                  INTEGER,
        wickets_lbw                     INTEGER,
        wickets_caught                  INTEGER,
        wickets_caught_and_bowled       INTEGER,
        wickets_stumped                 INTEGER,
        wickets_hit_wicket              INTEGER,
        economy                         FLOAT,
        per_ball_economy                FLOAT,
        sr                              FLOAT,
        dot_pct                         FLOAT,
        boundary_pct                    FLOAT,
        team_relative_economy           FLOAT,
        team_relative_per_ball_economy  FLOAT,
        team_relative_dot_pct           FLOAT,
        team_relative_sr                FLOAT,
        PRIMARY KEY (match_id, innings_number, bowler_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS bowling_spells (
        match_id         VARCHAR,
        innings_number   INTEGER,
        bowler           VARCHAR,
        bowler_id        VARCHAR,
        spell_number     INTEGER,
        first_over       FLOAT,
        last_over        FLOAT,
        overs_bowled     FLOAT,
        balls            INTEGER,
        runs_conceded    INTEGER,
        wide_runs        INTEGER,
        noball_runs      INTEGER,
        dots             INTEGER,
        fours            INTEGER,
        sixes            INTEGER,
        maidens          INTEGER,
        wickets          INTEGER,
        economy          FLOAT,
        per_ball_economy FLOAT,
        sr               FLOAT,
        dot_pct          FLOAT,
        boundary_pct     FLOAT,
        PRIMARY KEY (match_id, innings_number, bowler_id, spell_number)
    )
    """,
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def build_registry(info):
    """Return name→id dict from info.registry.people."""
    return info.get("registry", {}).get("people", {})


def lookup(registry, name):
    """Look up player_id from registry. Return None if not found."""
    return registry.get(name)


def cast_str(val):
    """Cast value to string — handles integer season / event.group."""
    if val is None:
        return None
    return str(val)


def parse_season_years(season_str):
    import re
    if season_str is None:
        return None, None
    s = str(season_str).strip()
    if re.match(r'^\d{4}$', s):
        y = int(s)
        return y, y
    m = re.match(r'^(\d{4})/(\d{2})$', s)
    if m:
        start = int(m.group(1))
        end = (start // 100) * 100 + int(m.group(2))
        return start, end
    return None, None


def get_outcome_fields(outcome):
    """Parse all 8 validated outcome shapes into flat fields."""
    winner             = outcome.get("winner")
    result_type        = outcome.get("result")
    method             = outcome.get("method")
    eliminator         = outcome.get("eliminator")
    result_margin      = None
    result_margin_type = None

    by = outcome.get("by", {})
    if by:
        for margin_type in ("runs", "wickets", "innings"):
            if margin_type in by:
                result_margin      = int(by[margin_type])
                result_margin_type = margin_type
                break

    if eliminator and result_type:
        result_type = f"{result_type} ({eliminator})"
    elif eliminator:
        result_type = eliminator

    bowl_out = outcome.get("bowl_out")

    return winner, result_type, result_margin, result_margin_type, method, bowl_out


def next_official_id(con):
    """Generate next synthetic official_id."""
    row = con.execute("SELECT COUNT(*) FROM officials_registry").fetchone()
    return f"off_{row[0] + 1:06d}"


def upsert_player(con, player_id, player_name):
    con.execute("""
        INSERT INTO player_registry (player_id, player_name)
        VALUES (?, ?)
        ON CONFLICT (player_id) DO NOTHING
    """, [player_id, player_name])


def upsert_official(con, official_name):
    """Insert official if not present; return their official_id."""
    row = con.execute(
        "SELECT official_id FROM officials_registry WHERE official_name = ?",
        [official_name]
    ).fetchone()
    if row:
        return row[0]
    oid = next_official_id(con)
    con.execute(
        "INSERT INTO officials_registry (official_id, official_name) VALUES (?, ?)",
        [oid, official_name]
    )
    return oid



# ── Phase 5 helpers ───────────────────────────────────────────────────────────

def safe_div(n, d):
    if d is None or d == 0 or n is None:
        return None
    return n / d

def safe_pct(n, d):
    r = safe_div(n, d)
    return r * 100 if r is not None else None

def cricket_overs(complete, balls):
    if complete == 0 and balls == 0:
        return 0.0
    return float(f"{complete}.{balls}")

def compute_overs_bowled(over_counts):
    complete = sum(1 for c in over_counts.values() if c == 6)
    incomplete = sum(c for c in over_counts.values() if c < 6)
    return cricket_overs(complete, incomplete)

def compute_maiden(over_dels):
    legal = [d for d in over_dels if d['wide'] is None]
    if len(legal) != 6:
        return False
    return sum((d['runs_batter'] or 0) + (d['wide'] or 0) + (d['noball'] or 0) for d in over_dels) == 0

def groupby_over(deliveries):
    od = defaultdict(list)
    for d in deliveries:
        od[d['over_number']].append(d)
    return sorted(od.items())

def identify_spells(over_numbers):
    if not over_numbers:
        return []
    spells = [[over_numbers[0]]]
    for i in range(1, len(over_numbers)):
        if over_numbers[i] - over_numbers[i-1] >= 3:
            spells.append([over_numbers[i]])
        else:
            spells[-1].append(over_numbers[i])
    return spells

def team_stats(deliveries):
    balls = runs = dots = bb = bnd = 0
    for d in deliveries:
        if d['wide'] is not None:
            continue
        balls += 1
        r = d['runs_batter'] or 0
        runs += r
        if r == 0:
            dots += 1
        inb = d['is_not_boundary']
        if r == 4 and not inb:
            bnd += 4; bb += 1
        elif r == 6 and not inb:
            bnd += 6; bb += 1
    nbr = runs - bnd
    nbb = balls - bb
    return {
        'balls': balls, 'runs': runs, 'dots': dots,
        'bb': bb, 'bnd': bnd, 'nbr': nbr, 'nbb': nbb,
        'sr':    safe_pct(runs, balls),
        'dpt':   safe_pct(dots, balls),
        'bpb':   safe_div(balls, bb if bb > 0 else None),
        'nbsr':  safe_pct(nbr, nbb),
    }

def team_stats_window(deliveries, e_over, e_ball, x_over, x_ball):
    w = [d for d in deliveries
         if (d['over_number'], d['ball_index']) >= (e_over, e_ball)
         and (d['over_number'], d['ball_index']) <= (x_over, x_ball)]
    return team_stats(w)


def build_batters(con, match_id, innings_meta):
    for inn_num, is_so in innings_meta:
        if is_so:
            continue
        rows = con.execute("""
            SELECT over_number, ball_index, batter, batter_id,
                   non_striker, runs_batter, wides, is_not_boundary,
                   wicket_count, player_out, wicket_kind
            FROM deliveries WHERE match_id=? AND innings_number=?
            ORDER BY over_number, ball_index
        """, [match_id, inn_num]).fetchall()
        if not rows:
            continue
        dels = [{'over_number':r[0],'ball_index':r[1],'batter':r[2],'batter_id':r[3],
                 'non_striker':r[4],'runs_batter':r[5],'wide':r[6],'is_not_boundary':r[7],
                 'wicket_count':r[8],'player_out':r[9],'wicket_kind':r[10]} for r in rows]
        tf = team_stats(dels)
        tib = tf['balls']
        seen = []
        bid_map = {}
        for d in dels:
            if d['wide'] is not None: continue
            if d['batter'] not in seen: seen.append(d['batter'])
            if d['batter'] and d['batter'] not in bid_map: bid_map[d['batter']] = d['batter_id']
        wk_rows = con.execute("SELECT player_out, kind FROM wickets WHERE match_id=? AND innings_number=?", [match_id, inn_num]).fetchall()
        wk = {r[0]: r[1] for r in wk_rows if r[0]}
        for pos, batter in enumerate(seen, 1):
            bd = [d for d in dels if d['batter']==batter or d['non_striker']==batter]
            if not bd: continue
            eo,eb = bd[0]['over_number'], bd[0]['ball_index']
            xo,xb = bd[-1]['over_number'], bd[-1]['ball_index']
            wdel = [d for d in dels if (d['over_number'],d['ball_index'])>=(eo,eb) and (d['over_number'],d['ball_index'])<=(xo,xb)]
            partners = len({d['batter'] for d in wdel if d['batter'] and d['batter']!=batter} |
                           {d['non_striker'] for d in wdel if d['non_striker'] and d['non_striker']!=batter})
            faced = [d for d in dels if d['batter']==batter and d['wide'] is None]
            runs = sum(d['runs_batter'] or 0 for d in faced)
            bf   = len(faced)
            dots = sum(1 for d in faced if (d['runs_batter'] or 0)==0)
            ones = sum(1 for d in faced if (d['runs_batter'] or 0)==1)
            twos = sum(1 for d in faced if (d['runs_batter'] or 0)==2)
            threes=sum(1 for d in faced if (d['runs_batter'] or 0)==3)
            fives= sum(1 for d in faced if (d['runs_batter'] or 0)==5)
            fours= sum(1 for d in faced if (d['runs_batter'] or 0)==4 and not d['is_not_boundary'])
            nbf  = sum(1 for d in faced if (d['runs_batter'] or 0)==4 and d['is_not_boundary'])
            sixes= sum(1 for d in faced if (d['runs_batter'] or 0)==6 and not d['is_not_boundary'])
            nbs  = sum(1 for d in faced if (d['runs_batter'] or 0)==6 and d['is_not_boundary'])
            bnd  = (fours*4)+(sixes*6)
            nbr  = runs - bnd
            bb   = fours+sixes
            nbb  = bf - bb
            dk   = wk.get(batter)
            out  = ('retired hurt' if dk=='retired hurt' else 'retired out' if dk=='retired out'
                    else 'retired not out' if dk=='retired not out' else 'dismissed') if dk else 'not out'
            sr   = safe_pct(runs,bf); dpt=safe_pct(dots,bf)
            brp  = safe_pct(bnd,runs); nbrp=safe_pct(nbr,runs)
            nbsr = safe_pct(nbr,nbb)
            bpb  = safe_div(bf,bb if bb>0 else None)
            bp4  = safe_div(bf,fours if fours>0 else None)
            bp6  = safe_div(bf,sixes if sixes>0 else None)
            bfp  = safe_pct(bf,tib)
            tr_sr  = (sr-tf['sr'])   if sr   is not None and tf['sr']   is not None else None
            tr_dpt = (dpt-tf['dpt']) if dpt  is not None and tf['dpt']  is not None else None
            tr_bpb = (bpb-tf['bpb']) if bpb  is not None and tf['bpb']  is not None else None
            tr_nb  = (nbsr-tf['nbsr']) if nbsr is not None and tf['nbsr'] is not None else None
            tw = team_stats_window(dels,eo,eb,xo,xb)
            wr_sr  = (sr-tw['sr'])   if sr   is not None and tw['sr']   is not None else None
            wr_dpt = (dpt-tw['dpt']) if dpt  is not None and tw['dpt']  is not None else None
            wr_bpb = (bpb-tw['bpb']) if bpb  is not None and tw['bpb']  is not None else None
            wr_nb  = (nbsr-tw['nbsr']) if nbsr is not None and tw['nbsr'] is not None else None
            con.execute("""INSERT INTO innings_batters VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [match_id,inn_num,pos,batter,bid_map.get(batter),eb,xb,out,dk,partners,
                 runs,bf,dots,ones,twos,threes,fours,nbf,fives,sixes,nbs,nbr,
                 sr,dpt,brp,nbrp,nbsr,bpb,bp4,bp6,bfp,
                 tr_sr,tr_dpt,tr_bpb,tr_nb,wr_sr,wr_dpt,wr_bpb,wr_nb])


def build_bowlers(con, match_id, innings_meta):
    for inn_num, is_so in innings_meta:
        if is_so:
            continue
        rows = con.execute("""
            SELECT over_number, ball_index, bowler, bowler_id,
                   runs_batter, wides, noballs, is_not_boundary
            FROM deliveries WHERE match_id=? AND innings_number=?
            ORDER BY over_number, ball_index
        """, [match_id, inn_num]).fetchall()
        if not rows:
            continue
        dels = [{'over_number':r[0],'ball_index':r[1],'bowler':r[2],'bowler_id':r[3],
                 'runs_batter':r[4],'wide':r[5],'noball':r[6],'is_not_boundary':r[7]} for r in rows]
        wk_rows = con.execute("SELECT over_number, ball_index, kind FROM wickets WHERE match_id=? AND innings_number=?", [match_id, inn_num]).fetchall()
        wkd = defaultdict(list)
        for o,b,k in wk_rows: wkd[(o,b)].append(k)
        t_balls = sum(1 for d in dels if d['wide'] is None and d['noball'] is None)
        t_runs  = sum((d['runs_batter'] or 0)+(d['wide'] or 0)+(d['noball'] or 0) for d in dels)
        t_dots  = sum(1 for d in dels if d['wide'] is None and (d['runs_batter'] or 0)==0 and (d['wide'] or 0)==0 and (d['noball'] or 0)==0)
        t_wkts  = sum(1 for d in dels for k in wkd.get((d['over_number'],d['ball_index']),[]) if k in BOWLER_WICKET_KINDS)
        bd = defaultdict(list); bid_map={}
        for d in dels:
            bd[d['bowler']].append(d)
            if d['bowler'] and d['bowler'] not in bid_map: bid_map[d['bowler']]=d['bowler_id']
        for bowler, bdels in bd.items():
            legal=[d for d in bdels if d['wide'] is None and d['noball'] is None]
            balls=len(legal)
            olc=defaultdict(int)
            for d in legal: olc[d['over_number']]+=1
            all_overs=sorted(set(d['over_number'] for d in bdels))
            fon=all_overs[0]; lon=all_overs[-1]
            fob=olc[fon]; lob=olc[lon]
            ff=float(fon) if fob==6 else cricket_overs(fon,fob)
            lf=float(lon) if lob==6 else cricket_overs(lon,lob)
            ov=compute_overs_bowled(dict(olc))
            sc=1
            for i in range(1,len(all_overs)):
                if all_overs[i]-all_overs[i-1]>=3: sc+=1
            rc=sum((d['runs_batter'] or 0)+(d['wide'] or 0)+(d['noball'] or 0) for d in bdels)
            wr=sum(d['wide'] or 0 for d in bdels)
            nr=sum(d['noball'] or 0 for d in bdels)
            dots=sum(1 for d in legal if (d['runs_batter'] or 0)==0 and (d['wide'] or 0)==0 and (d['noball'] or 0)==0)
            fours=sum(1 for d in legal if (d['runs_batter'] or 0)==4 and not d['is_not_boundary'])
            sixes=sum(1 for d in legal if (d['runs_batter'] or 0)==6 and not d['is_not_boundary'])
            maidens=sum(1 for _,od in groupby_over(bdels) if compute_maiden(od))
            wkts=wb=wl=wc=wcb=ws=whw=0
            for d in legal:
                for k in wkd.get((d['over_number'],d['ball_index']),[]):
                    if k in BOWLER_WICKET_KINDS:
                        wkts+=1
                        if k=='bowled': wb+=1
                        elif k=='lbw': wl+=1
                        elif k=='caught': wc+=1
                        elif k=='caught and bowled': wcb+=1
                        elif k=='stumped': ws+=1
                        elif k=='hit wicket': whw+=1
            econ=safe_div(rc,ov if ov>0 else None)
            pbe=safe_div(rc,balls if balls>0 else None)
            sr=safe_div(balls,wkts if wkts>0 else None)
            dpt=safe_pct(dots,balls)
            bpct=safe_pct((fours*4)+(sixes*6),rc)
            te=safe_div(t_runs,t_balls/6 if t_balls>0 else None)
            tp=safe_div(t_runs,t_balls)
            td=safe_pct(t_dots,t_balls)
            ts=safe_div(t_balls,t_wkts if t_wkts>0 else None)
            tre=(econ-te) if econ is not None and te is not None else None
            trp=(pbe-tp)  if pbe  is not None and tp is not None else None
            trd=(dpt-td)  if dpt  is not None and td is not None else None
            trs=(sr-ts)   if sr   is not None and ts is not None else None
            bid=bid_map.get(bowler)
            con.execute("""INSERT INTO innings_bowlers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [match_id,inn_num,bowler,bid,ff,lf,sc,ov,balls,rc,wr,nr,dots,fours,sixes,maidens,
                 wkts,wb,wl,wc,wcb,ws,whw,econ,pbe,sr,dpt,bpct,tre,trp,trd,trs])
            spells=identify_spells(all_overs)
            for sn,sovs in enumerate(spells,1):
                sd=[d for d in bdels if d['over_number'] in sovs]
                sl=[d for d in sd if d['wide'] is None and d['noball'] is None]
                sb=len(sl)
                soc=defaultdict(int)
                for d in sl: soc[d['over_number']]+=1
                sov=compute_overs_bowled(dict(soc))
                sfn=sovs[0]; sln=sovs[-1]
                sfb=soc[sfn]; slb=soc[sln]
                sff=float(sfn) if sfb==6 else cricket_overs(sfn,sfb)
                slf=float(sln) if slb==6 else cricket_overs(sln,slb)
                src=sum((d['runs_batter'] or 0)+(d['wide'] or 0)+(d['noball'] or 0) for d in sd)
                swr=sum(d['wide'] or 0 for d in sd)
                snr=sum(d['noball'] or 0 for d in sd)
                sdots=sum(1 for d in sl if (d['runs_batter'] or 0)==0 and (d['wide'] or 0)==0 and (d['noball'] or 0)==0)
                sf4=sum(1 for d in sl if (d['runs_batter'] or 0)==4 and not d['is_not_boundary'])
                sf6=sum(1 for d in sl if (d['runs_batter'] or 0)==6 and not d['is_not_boundary'])
                smdn=sum(1 for _,od in groupby_over(sd) if compute_maiden(od))
                swk=sum(1 for d in sl for k in wkd.get((d['over_number'],d['ball_index']),[]) if k in BOWLER_WICKET_KINDS)
                se=safe_div(src,sov if sov>0 else None)
                sp=safe_div(src,sb if sb>0 else None)
                ss=safe_div(sb,swk if swk>0 else None)
                sdp=safe_pct(sdots,sb)
                sbp=safe_pct((sf4*4)+(sf6*6),src)
                con.execute("""INSERT INTO bowling_spells VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    [match_id,inn_num,bowler,bid,sn,sff,slf,sov,sb,src,swr,snr,sdots,sf4,sf6,smdn,swk,se,sp,ss,sdp,sbp])


# ── Per-file ingestion ─────────────────────────────────────────────────────

def ingest_file(con, filepath, registry_misses):
    filename = filepath.name
    stem     = filepath.stem  # full stem — handles wi_ prefix correctly

    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)

    meta         = data.get("meta", {})
    info         = data.get("info", {})
    innings_list = data.get("innings", [])

    registry = build_registry(info)

    # ── player_registry ───────────────────────────────────────────────────────
    for name, pid in registry.items():
        upsert_player(con, pid, name)

    # ── matches ───────────────────────────────────────────────────────────────
    dates = info.get("dates", [])

    def get_date(i):
        return dates[i] if i < len(dates) else None

    teams   = info.get("teams", [])
    toss    = info.get("toss", {})
    event   = info.get("event", {})
    outcome = info.get("outcome", {})

    winner, result_type, result_margin, result_margin_type, method, bowl_out = \
        get_outcome_fields(outcome)

    supersubs = info.get("supersubs")

    season_str = cast_str(info.get("season"))
    season_year_start, season_year_end = parse_season_years(season_str)

    con.execute("""
        INSERT INTO matches VALUES (
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        )
    """, [
        stem,
        info.get("match_type"),
        info.get("gender"),
        season_str,
        season_year_start,
        season_year_end,
        info.get("city"),
        info.get("venue"),
        get_date(0), get_date(1), get_date(2),
        get_date(3), get_date(4), get_date(5),
        info.get("balls_per_over"),
        info.get("overs"),
        info.get("team_type"),
        teams[0] if len(teams) > 0 else None,
        teams[1] if len(teams) > 1 else None,
        toss.get("winner"),
        toss.get("decision"),
        toss.get("uncontested", False) or False,
        event.get("name"),
        event.get("match_number"),
        cast_str(event.get("group")),
        event.get("stage"),
        event.get("sub_name"),
        winner,
        result_type,
        result_margin,
        result_margin_type,
        method,
        json.dumps(supersubs) if supersubs else None,
        json.dumps(bowl_out)  if bowl_out  else None,
        json.dumps(info.get("missing")) if info.get("missing") else None,
        json.dumps(meta),
    ])

    # ── match_dates_overflow ──────────────────────────────────────────────────
    if len(dates) > 6:
        for i, d in enumerate(dates, 1):
            con.execute(
                "INSERT INTO match_dates_overflow VALUES (?, ?, ?)",
                [stem, i, d]
            )

    # ── match_players ─────────────────────────────────────────────────────────
    # A squad name missing from this file's own registry must not drop the
    # whole match (owner decision 41 / B6 fix a) — skip just this link, don't
    # invent an id, and surface it loudly after the ingest loop.
    for team, players in info.get("players", {}).items():
        for pname in players:
            pid = lookup(registry, pname)
            if pid is None:
                registry_misses.append((filename, stem, pname, "squad"))
                continue
            con.execute(
                "INSERT INTO match_players VALUES (?, ?, ?, ?)",
                [stem, team, pname, pid]
            )

    # ── match_player_of_match ─────────────────────────────────────────────────
    for pname in info.get("player_of_match", []):
        pid = lookup(registry, pname)
        if pid is None:
            registry_misses.append((filename, stem, pname, "player_of_match"))
            continue
        con.execute(
            "INSERT OR IGNORE INTO match_player_of_match VALUES (?, ?, ?)",
            [stem, pname, pid]
        )

    # ── officials ─────────────────────────────────────────────────────────────
    for role, names in info.get("officials", {}).items():
        for oname in names:
            oid = upsert_official(con, oname)
            con.execute(
                "INSERT INTO officials VALUES (?, ?, ?, ?)",
                [stem, oname, oid, role]
            )

    # ── innings ───────────────────────────────────────────────────────────────
    innings_meta = []
    for inn_num, innings in enumerate(innings_list):
        target  = innings.get("target", {})
        penalty = innings.get("penalty_runs", {})

        is_super_over = innings.get("super_over", False) or False
        innings_meta.append((inn_num, is_super_over))

        con.execute("""
            INSERT INTO innings VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        """, [
            stem,
            inn_num,
            innings.get("team"),
            innings.get("declared", False) or False,
            innings.get("forfeited", False) or False,
            is_super_over,
            target.get("runs"),
            target.get("overs"),
            penalty.get("pre"),
            penalty.get("post"),
            json.dumps(innings.get("miscounted_overs")) if innings.get("miscounted_overs") else None,
            json.dumps(innings.get("absent_hurt"))      if innings.get("absent_hurt")      else None,
        ])

        # ── powerplays ────────────────────────────────────────────────────────
        for pp_idx, pp in enumerate(innings.get("powerplays", [])):
            con.execute(
                "INSERT INTO powerplays VALUES (?,?,?,?,?,?)",
                [stem, inn_num, pp_idx, pp.get("from"), pp.get("to"), pp.get("type")]
            )

        # ── overs / deliveries ────────────────────────────────────────────────
        for over_obj in innings.get("overs", []):
            over_number = over_obj.get("over")

            for ball_idx, delivery in enumerate(over_obj.get("deliveries", [])):

                # Silently ignore delivery-level 'over' field (affects 13 files)
                # (we simply never read delivery['over'])

                bat  = delivery.get("batter")
                bowl = delivery.get("bowler")
                ns   = delivery.get("non_striker")

                runs   = delivery.get("runs", {})
                extras = delivery.get("extras", {})

                wickets_raw  = delivery.get("wickets", [])
                wicket_count = len(wickets_raw)

                # Convenience columns — first wicket only
                first_w         = wickets_raw[0] if wicket_count > 0 else {}
                wicket_kind     = first_w.get("kind")
                # playeer_out typo handling
                player_out_name = (
                    first_w.get("player_out") or first_w.get("playeer_out")
                ) if first_w else None
                player_out_id   = lookup(registry, player_out_name) if player_out_name else None

                dqf = None
                if wicket_count > 2:
                    dqf = f"wicket_count_suspect: {wicket_count} wickets on single delivery"

                review = delivery.get("review", {})

                con.execute("""
                    INSERT INTO deliveries VALUES (
                        ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
                    )
                """, [
                    stem, inn_num, over_number, ball_idx,
                    bat,  lookup(registry, bat),
                    bowl, lookup(registry, bowl),
                    ns,   lookup(registry, ns),
                    runs.get("batter", 0),
                    runs.get("extras", 0),
                    runs.get("total",  0),
                    runs.get("non_boundary"),  # maps to is_not_boundary
                    extras.get("wides"),
                    extras.get("noballs"),
                    extras.get("byes"),
                    extras.get("legbyes"),
                    extras.get("penalty"),
                    wicket_count,
                    wicket_kind,
                    player_out_name,
                    player_out_id,
                    dqf,
                    review.get("by"),
                    review.get("umpire"),
                    review.get("batter"),
                    review.get("decision"),
                    review.get("type"),
                    review.get("umpires_call"),
                    json.dumps(delivery.get("replacements")) if delivery.get("replacements") else None,
                ])

                # ── wickets ───────────────────────────────────────────────────
                for w_idx, w in enumerate(wickets_raw):
                    pout_name = w.get("player_out") or w.get("playeer_out")
                    pout_id   = lookup(registry, pout_name) if pout_name else None
                    con.execute("""
                        INSERT INTO wickets VALUES (?,?,?,?,?,?,?,?)
                    """, [
                        stem, inn_num, over_number, ball_idx,
                        w_idx, pout_name, pout_id, w.get("kind")
                    ])

                    # ── wicket_fielders ───────────────────────────────────────
                    for f_idx, fielder in enumerate(w.get("fielders", [])):
                        fname = fielder.get("name")
                        fid   = lookup(registry, fname) if fname else None
                        con.execute("""
                            INSERT INTO wicket_fielders VALUES (?,?,?,?,?,?,?,?,?)
                        """, [
                            stem, inn_num, over_number, ball_idx,
                            w_idx, f_idx,
                            fname, fid,
                            fielder.get("substitute", False) or False,
                        ])

    # ── Phase 5 summary tables ────────────────────────────────────────────────
    build_batters(con, stem, innings_meta)
    build_bowlers(con, stem, innings_meta)

    # ── ingested_files — always last ──────────────────────────────────────────
    con.execute(
        "INSERT INTO ingested_files VALUES (?, ?)",
        [filename, stem]
    )


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    log.info("=== ingest.py starting ===")
    log.info(f"DB path : {DB_PATH}")
    log.info(f"JSON dir: {JSON_DIR}")

    # ── Download from Cricsheet ───────────────────────────────────────────────
    try:
        download_cricsheet()

        # ── Connect and create schema ─────────────────────────────────────────
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        con = duckdb.connect(str(DB_PATH))

        for stmt in SCHEMA_STATEMENTS:
            con.execute(stmt)
        log.info("Schema created (all tables)")
    except Exception as e:
        log.error(f"FATAL: could not download/prepare Cricsheet data: {e}")
        alerts.send_alert(
            "Pipeline could not download/prepare Cricsheet data — run failed before ingest",
            f"ingest.py failed before the per-file ingestion loop started, while "
            f"downloading Cricsheet data or preparing the schema:\n\n{e}\n\n"
            f"No files were ingested this run. The run has failed red.\n",
        )
        raise

    # ── Build file list ───────────────────────────────────────────────────────
    all_files = sorted(JSON_DIR.glob("*.json"))
    log.info(f"JSON files found: {len(all_files)}")

    already_ingested = {
        r[0] for r in con.execute("SELECT file_name FROM ingested_files").fetchall()
    }

    to_process = [f for f in all_files if f.name not in already_ingested]
    skipped    = len(all_files) - len(to_process)

    if skipped:
        log.info(f"Skipping {skipped} already-ingested files")
    log.info(f"Processing {len(to_process)} files")

    # ── Ingest ────────────────────────────────────────────────────────────────
    errors          = []
    processed       = 0
    registry_misses = []

    for filepath in tqdm(to_process, desc="Ingesting", unit="file"):
        file_misses = []
        try:
            con.begin()
            ingest_file(con, filepath, file_misses)
            con.commit()
            processed += 1
            registry_misses.extend(file_misses)  # only report misses for files that actually committed
        except Exception as e:
            con.rollback()
            errors.append((filepath.name, str(e)))
            log.error(f"FAILED: {filepath.name} — {e}")

    # ── Summary ───────────────────────────────────────────────────────────────
    log.info("")
    log.info("Ingestion complete.")
    log.info(f"  Processed : {processed}")
    log.info(f"  Skipped   : {skipped}")
    log.info(f"  Errors    : {len(errors)}")
    if errors:
        log.info("  Error detail:")
        for fn, err in errors:
            log.info(f"    {fn}: {err}")

    log.info(f"  Registry misses : {len(registry_misses)}")
    if registry_misses:
        log.warning(
            f"  {len(registry_misses)} squad/player-of-match name(s) were missing "
            f"from their own file's registry — each match STILL ingested in full "
            f"(deliveries, wickets, innings all present); only that one link was "
            f"skipped:"
        )
        for fn, mid, pname, ctx in registry_misses:
            log.warning(f"    {fn}  match_id={mid}  player_name={pname!r}  ({ctx})")

        misses_body = "\n".join(
            f"  - {fn}  match_id={mid}  player_name={pname!r}  ({ctx})"
            for fn, mid, pname, ctx in registry_misses
        )
        alerts.send_alert(
            "Cricsheet file inconsistency: player missing from registry",
            f"{len(registry_misses)} squad/player-of-match name(s) referenced in a "
            f"Cricsheet file were not found in that same file's info.registry.people "
            f"map. Each affected match WAS ingested in full (deliveries, wickets, "
            f"and innings are all present) — only that one player's squad or "
            f"player-of-match link was skipped, since inventing a player_id would "
            f"be worse than a missing row.\n\n{misses_body}\n",
        )


    con.close()
    log.info(f"Log written to: {LOG_PATH}")
    log.info("=== ingest.py done ===")


if __name__ == "__main__":
    main()
