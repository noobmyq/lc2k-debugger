size	lw	0	1	n	a program to calculate the combination of two numbers
iter	lw	0	2	r
comb	lw	0	7	pos1	r7=1
	add	1	7	1	r1++
	add	2	7	2	r2++
mult1	beq	5	2	end1
	add	5	7	5
	add	6	1	6
	beq	0	0	mult1
end1	add	0	0	5	r5=0
for	beq	5	6	end
	sw	0	6	size
	sw	0	5	iter	store iterator value to iter
	beq	3	1	incr4
	beq	0	0	cont1
incr4	add	4	7	4	r4++ (row)
	add	0	0	3	r3=0
	beq	0	0	cont2
cont1	beq	0	4	add1	r4==0 check if it is first row,
	beq	0	0	cont2
add1	sw	5	7	arr	arr[r5]=1
	add	5	7	5	r5++
	add	3	7	3	r3++ (col)
	beq	0	0	for
cont2	beq	3	4	add1	r3==r4 row==col, free reg: r5,r6,r7
	beq	3	0	add1	r3==0 arr[r5]=1
	nor	1	1	6	r6=~r1
	add	6	7	6	r6=~r1+1
	add	5	6	6	r6=r5-1
	lw	0	7	neg1	r7=-1
	add	7	6	6	r6--
	lw	6	7	arr	r7=arr[i-1-n]
	add	6	1	6	r6+=n
	lw	6	6	arr	r6=arr[i-1]
	add	6	7	6	r6=arr[i-1]+arr[i-1-n]
	sw	5	6	arr	arr[i]=r6
	lw	0	6	size	restore r6 to size
	lw	0	7	pos1	r7=1
	add	5	7	5	r5++
	add	3	7	3	r3++ (col)
	beq	0	0	for
end	lw	0	7	neg1	r7=-1
	add	6	7	6	r6--
	lw	6	3	arr	r3=arr[r6]
	halt
n	.fill	14
r	.fill	7
pos1	.fill	1
neg1	.fill	-1
last1	.fill	0
arr	.fill	0
