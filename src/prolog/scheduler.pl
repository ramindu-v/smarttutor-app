% SmartTutor timetable solver (SWI-Prolog, run inside Node.js via swipl-wasm)
%
% Facts are asserted at runtime by src/scheduler.js through load_problem/1. Teachers, rooms and grade
% groups are numbered 1..N so that the search can keep its state in compact
% bitmasks (one bit per weekly time slot):
%
%   slot(S, Day, Hour, Index)      S = 0..N-1, Day 0..6 (Mon..Sun), Index = position within the day
%   room(R, Capacity, IsLab)       IsLab is 1 or 0
%   available(T, Day)
%   class(Id, G, T, Size, NeedsLab, Preference)   Preference: weekday | weekend | any
%   counts(Teachers, Rooms, Grades)
%   setting(Name, Value)           max_per_day, no_back_to_back, lunch_break, priority
%
% An assignment is a(ClassId, G, T, R, Day, Hour, Index).

:- use_module(library(lists)).
:- use_module(library(apply)).

:- dynamic slot/4, room/3, available/2, class/6, counts/3, setting/2.

load_problem(Facts) :-
    retractall(slot(_, _, _, _)), retractall(room(_, _, _)),
    retractall(available(_, _)), retractall(class(_, _, _, _, _, _)),
    retractall(counts(_, _, _)), retractall(setting(_, _)),
    maplist(assertz, Facts).

% ---------------------------------------------------------------- hard constraints

usable_hour(H) :- \+ (setting(lunch_break, true), H =:= 12).

usable(D, H, I) :- slot(_, D, H, I), usable_hour(H).

lab_ok(0, _).
lab_ok(1, 1).

room_fits(Size, NeedsLab, R, Cap) :-
    room(R, Cap, IsLab),
    Cap >= Size,
    lab_ok(NeedsLab, IsLab).

% ---------------------------------------------------------------- search state
% Each class's options are computed once and stored in the database, indexed by
% class id. The search itself only carries class ids and bitmasks around.

:- dynamic opt/9.        % opt(ClassId, Day, Hour, Index, Room, Capacity, Bit, DayMask, AdjacentMask)
:- dynamic day_bits/2.
:- dynamic adj_bits/3.

slot_masks :-
    retractall(day_bits(_, _)), retractall(adj_bits(_, _, _)),
    findall(D, slot(_, D, _, _), Ds0), sort(Ds0, Ds),
    (   member(D, Ds),
        findall(B, ( slot(S, D, _, _), B is 1 << S ), Bs), sum_list(Bs, M),
        assertz(day_bits(D, M)), fail ; true ),
    (   slot(_, D, _, I),
        findall(B, ( slot(S, D, _, I2), Diff is abs(I2 - I), Diff =:= 1, B is 1 << S ), Bs), sum_list(Bs, M),
        assertz(adj_bits(D, I, M)), fail ; true ).

% Every slot/room pair that respects teacher availability, room capacity,
% lab needs and the lunch break.
build_options(Ids) :-
    retractall(opt(_, _, _, _, _, _, _, _, _)),
    (   member(Id, Ids),
        class(Id, _, T, Size, NeedsLab, _),
        available(T, D),
        day_bits(D, DayMask),
        slot(S, D, H, I),
        usable_hour(H),
        Bit is 1 << S,
        adj_bits(D, I, Adj),
        room_fits(Size, NeedsLab, R, Cap),
        assertz(opt(Id, D, H, I, R, Cap, Bit, DayMask, Adj)),
        fail
    ;   true
    ).

popcount(0, 0) :- !.
popcount(X, N) :- Y is X /\ (X - 1), popcount(Y, N0), N is N0 + 1.

% State: st(TeacherMasks, RoomMasks, GradeMasks), each a term m(M1, ..., Mn)
% holding one bit per weekly slot that is already booked.
free(Id, st(TB, RB, GB), opt(Id, D, H, I, R, Cap, Bit, DayMask, Adj)) :-
    class(Id, G, T, _, _, _),
    opt(Id, D, H, I, R, Cap, Bit, DayMask, Adj),
    arg(T, TB, TM), TM /\ Bit =:= 0,
    arg(R, RB, RM), RM /\ Bit =:= 0,
    arg(G, GB, GM), GM /\ Bit =:= 0,
    setting(max_per_day, Max),
    Today is TM /\ DayMask,
    popcount(Today, Load), Load < Max,
    ( setting(no_back_to_back, true) -> TM /\ Adj =:= 0 ; true ).

set_bit(K, Term, Bit, New) :-
    Term =.. [F|Args],
    or_nth(K, Args, Bit, Args2),
    New =.. [F|Args2].

or_nth(1, [X|Xs], B, [Y|Xs]) :- !, Y is X \/ B.
or_nth(K, [X|Xs], B, [X|Ys]) :- K1 is K - 1, or_nth(K1, Xs, B, Ys).

book(G, T, R, Bit, st(TB, RB, GB), st(TB2, RB2, GB2)) :-
    set_bit(T, TB, Bit, TB2),
    set_bit(R, RB, Bit, RB2),
    set_bit(G, GB, Bit, GB2).

zeros(0, []) :- !.
zeros(N, [0|Zs]) :- N1 is N - 1, zeros(N1, Zs).

empty_masks(N, Term) :- zeros(N, Zs), Term =.. [m|Zs].

empty_state(st(TB, RB, GB)) :-
    counts(NT, NR, NG),
    empty_masks(NT, TB), empty_masks(NR, RB), empty_masks(NG, GB).

book_fixed([], St, St).
book_fixed([a(_, G, T, R, D, H, I)|As], St0, St) :-
    slot(S, D, H, I), Bit is 1 << S,
    book(G, T, R, Bit, St0, St1),
    book_fixed(As, St1, St).

% ---------------------------------------------------------------- soft constraints (cost)

weekend_day(5).
weekend_day(6).

pref_penalty(any, _, 0).
pref_penalty(weekend, D, 0) :- weekend_day(D), !.
pref_penalty(weekday, D, 0) :- \+ weekend_day(D), !.
pref_penalty(_, _, 1).

cost(Id, st(TB, RB, GB), opt(_, D, H, _, R, Cap, _, DayMask, _), K) :-
    class(Id, G, T, Size, _, Pref),
    setting(priority, P),
    Waste is Cap - Size,
    arg(T, TB, TM), TeacherToday is TM /\ DayMask, popcount(TeacherToday, Load),
    arg(G, GB, GM), GradeToday is GM /\ DayMask, popcount(GradeToday, GradeLoad),
    RB =.. [_|RoomMasks], centre_load(RoomMasks, DayMask, 0, DayLoad),
    arg(R, RB, RM), popcount(RM, RoomLoad),
    pref_penalty(Pref, D, Pen),
    cost_for(P, c(Waste, Load, GradeLoad, DayLoad, RoomLoad, Pen, H), K).

% Number of classes already booked on a day across all rooms.
centre_load([], _, N, N).
centre_load([M|Ms], DayMask, N0, N) :-
    X is M /\ DayMask, popcount(X, C), N1 is N0 + C,
    centre_load(Ms, DayMask, N1, N).

% Lower is better. Each priority weighs the same factors differently:
%   Waste      empty seats in the room           Load       teacher's classes that day
%   GradeLoad  the grade's classes that day      DayLoad    classes in the centre that day
%   RoomLoad   classes already booked in the room this week
%   Pen        1 if the day is not the class's preferred kind (weekday / weekend)
cost_for(workload,   c(W, L, GL, DL, _,  Pen, H), K) :- K is L * 100000 + GL * 2000 + Pen * 1000 + DL * 50 + W + H.
cost_for(rooms,      c(W, L, GL, DL, _,  Pen, H), K) :- K is W * 100000 + Pen * 1000 + L * 300 + GL * 200 + DL * 10 + H.
cost_for(preference, c(W, L, GL, DL, _,  Pen, H), K) :- K is Pen * 100000 + GL * 2000 + L * 1000 + DL * 50 + W + H.
cost_for(balanced,   c(W, L, GL, DL, RL, Pen, H), K) :- K is Pen * 3000 + L * 800 + GL * 800 + DL * 60 + W * 8 + RL * 15 + H.

% ---------------------------------------------------------------- search

% Most constrained classes (fewest options) first.
order_classes(Ids, Sorted) :-
    findall(N-Id, ( member(Id, Ids), findall(x, opt(Id, _, _, _, _, _, _, _, _), L), length(L, N) ), Keyed),
    keysort(Keyed, SortedKeyed),
    findall(Id, member(_-Id, SortedKeyed), Sorted).

% Forward checking: every remaining class must still have at least one free option.
forward_ok([], _).
forward_ok([Id|Ids], St) :-
    once(free(Id, St, _)),
    forward_ok(Ids, St).

% Try options cheapest first and keep the first one that leaves every remaining
% class placeable; if none does, take the cheapest and carry on.
place(Id, Rest, St, A, St2) :-
    class(Id, G, T, _, _, _),
    findall(K-O, ( free(Id, St, O), cost(Id, St, O, K) ), Scored),
    Scored \== [],
    keysort(Scored, Sorted),
    (   member(_-O, Sorted),
        O = opt(_, _, _, _, R, _, Bit, _, _),
        book(G, T, R, Bit, St, St2),
        forward_ok(Rest, St2)
    ->  true
    ;   Sorted = [_-O|_],
        O = opt(_, _, _, _, R, _, Bit, _, _),
        book(G, T, R, Bit, St, St2)
    ),
    O = opt(_, D, H, I, R, _, _, _, _),
    A = a(Id, G, T, R, D, H, I).

search([], _, Acc, Acc, []).
search([Id|Ids], St, Acc, Out, Unplaced) :-
    (   place(Id, Ids, St, A, St2)
    ->  search(Ids, St2, [A|Acc], Out, Unplaced)
    ;   reason(Id, Why),
        Unplaced = [u(Id, Why)|U2],
        search(Ids, St, Acc, Out, U2)
    ).

reason(Id, no_suitable_room) :-
    class(Id, _, _, Size, NeedsLab, _),
    \+ room_fits(Size, NeedsLab, _, _), !.
reason(Id, teacher_unavailable) :-
    class(Id, _, T, _, _, _),
    \+ available(T, _), !.
reason(_, all_slots_conflict).

% plan(+Fixed, +ClassIds, -Out, -Unplaced)
% Fixed assignments are kept as they are (used for minimal-disruption rescheduling).
plan(Fixed, Ids, Out, Unplaced) :-
    slot_masks,
    build_options(Ids),
    empty_state(St0),
    book_fixed(Fixed, St0, St),
    order_classes(Ids, Ordered),
    search(Ordered, St, Fixed, Out, Unplaced).

% ---------------------------------------------------------------- validation

conflict_type(T, _, _, T, _, _, teacher).
conflict_type(_, R, _, _, R, _, room).
conflict_type(_, _, G, _, _, G, grade).

conflicts(Out, L) :-
    findall(c(Type, I1, I2),
            ( member(a(I1, G1, T1, R1, D, H, _), Out),
              member(a(I2, G2, T2, R2, D, H, _), Out),
              I1 < I2,
              conflict_type(T1, R1, G1, T2, R2, G2, Type) ),
            L).

day_load(T, D, Acc, N) :-
    findall(x, member(a(_, _, T, _, D, _, _), Acc), L),
    length(L, N).

% move_issue(+Id, +Day, +Hour, +Room, +Others, -Issue): why a manual move is not allowed.
move_issue(_, D, H, _, _, invalid_slot) :- \+ slot(_, D, H, _).
move_issue(_, D, H, _, _, lunch_break) :- slot(_, D, H, _), \+ usable_hour(H).
move_issue(Id, D, _, _, _, teacher_unavailable) :- class(Id, _, T, _, _, _), \+ available(T, D).
move_issue(Id, _, _, R, _, room_too_small) :- class(Id, _, _, Size, _, _), room(R, Cap, _), Cap < Size.
move_issue(Id, _, _, R, _, needs_lab) :- class(Id, _, _, _, 1, _), room(R, _, 0).
move_issue(Id, D, H, _, Others, teacher_busy) :- class(Id, _, T, _, _, _), member(a(_, _, T, _, D, H, _), Others).
move_issue(_, D, H, R, Others, room_busy) :- member(a(_, _, _, R, D, H, _), Others).
move_issue(Id, D, H, _, Others, grade_busy) :- class(Id, G, _, _, _, _), member(a(_, G, _, _, D, H, _), Others).
move_issue(Id, D, _, _, Others, max_per_day) :-
    class(Id, _, T, _, _, _), setting(max_per_day, Max), day_load(T, D, Others, N), N >= Max.
move_issue(Id, D, H, _, Others, back_to_back) :-
    setting(no_back_to_back, true), class(Id, _, T, _, _, _), slot(_, D, H, I),
    member(a(_, _, T, _, D, _, I2), Others), Diff is abs(I2 - I), Diff =:= 1.

move_issues(Id, D, H, R, Others, Issues) :-
    findall(X, move_issue(Id, D, H, R, Others, X), L),
    sort(L, Issues).
