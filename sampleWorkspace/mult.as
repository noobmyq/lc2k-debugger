	add	0	1	0
	lw	0	3	mplier	second multiplier b in reg3
	noop
	jalr	3	2
	lw	0	7	one	reg7 is 1, mask
	add	0	4	0	bit record store in reg4
	lw	0	5	sevent	reg5 is 17
	add	0	7	6	store reg6 with i, initialize as 1
for1	beq	5	6	end1
	nor	3	3	1	store ~b to reg1
	nor	7	7	2	store ~mask to reg2
	nor	1	2	2	store b&mask to reg2
	beq	2	0	jump1
else1	add	0	6	4
jump1	add	7	7	7	mask<<=1
	lw	0	2	one
	add	6	2	6	i++
	beq	0	0	for1
end1	lw	0	2	mcand	store mcand at reg2
	add	0	0	1	store result at reg1
	lw	0	7	one	store mask with 1
while	beq	0	4	end	while loop start
	nor	3	3	5	~b store in reg5
	nor	7	7	6	~mask store in reg6
	nor	5	6	6	b & mask store in reg6
if	beq	6	0	jump	if b&mask=0 jump to else
else	add	0	2	6	store c in reg6
	lw	0	5	one	store reg5 with i=1,
for	beq	7	5	forend	for loop start
	add	6	6	6	left shift c
	add	5	5	5	i<<=1
	beq	0	0	for
forend	add	1	6	1	result+=c
jump	add	7	7	7	mask<<=1;
	lw	0	5	minus1	load reg5=-1
	add	5	4	4	bit--
	beq	0	0	while
end	halt
mplier	.fill	3
one	.fill	1
sevent	.fill	17
mcand	.fill	3
minus1	.fill	-1
minus2	.fill	-2
